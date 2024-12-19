import { SWAP_ABI } from '@/abi'
import { MemecoinAPI } from '@/api'
import { MULTISIG_FEE_COLLECTOR, SWAPPER_CONTRACT } from '@/constants'
import { calculateMinAmountWithSlippage, isBigInt, isNull } from '@/functions'
import {
  EstimateSwapParams,
  EthAddress,
  HexString,
  HydratedCoin,
  ResolveTokenPoolResponse,
  SwapEstimation,
  SwapParams,
  TokenPoolType
} from '@/types'
import { UniswapV2 } from '@/uniswapv2'
import { UniswapV3 } from '@/uniswapv3'
import { Abi, encodeFunctionData, PublicClient, WalletClient } from 'viem'
import { base } from 'viem/chains'
import { eip5792Actions, writeContracts } from 'viem/experimental'

export class TokenSwapper {
  private readonly uniswapV3: UniswapV3
  private readonly uniswapV2: UniswapV2

  constructor(
    private readonly publicClient: PublicClient,
    private readonly walletClient: WalletClient,
    private readonly api: MemecoinAPI
  ) {
    this.uniswapV3 = new UniswapV3(this.publicClient)
    this.uniswapV2 = new UniswapV2(this.publicClient)
  }

  async estimateSwap(params: EstimateSwapParams): Promise<SwapEstimation> {
    const { tokenIn, tokenOut, amountIn, address, recipient, orderReferrer } = params

    const allowance = await this.api.getERC20Allowance(tokenIn, SWAPPER_CONTRACT, address)

    const [tokenInMemecoin, tokenOutMemecoin] = await Promise.all([
      this.api.getCoin(tokenIn),
      this.api.getCoin(tokenOut)
    ])

    const [tokenInData, tokenOutData] = await Promise.all([
      tokenInMemecoin
        ? this.resolvePoolOfMemecoin(tokenInMemecoin)
        : this.resolveTokenWETHPool(tokenIn),
      tokenOutMemecoin
        ? this.resolvePoolOfMemecoin(tokenOutMemecoin)
        : this.resolveTokenWETHPool(tokenOut)
    ])

    const tokenInPoolType = tokenInData.poolType
    const feeIn = tokenInData.poolFee
    const tokenOutPoolType = tokenOutData.poolType
    const feeOut = tokenOutData.poolFee

    if (isNull(tokenInPoolType) || isNull(tokenOutPoolType)) {
      throw new Error('No pool type found')
    }

    const { result } = await this.publicClient.simulateContract({
      account: address,
      address: SWAPPER_CONTRACT,
      abi: SWAP_ABI,
      functionName: 'swap',
      args: [
        {
          tokenIn,
          tokenOut,
          tokenInPoolType,
          tokenOutPoolType,
          recipient: recipient ?? address,
          amountIn,
          amountOutMinimum: 0n,
          orderReferrer: orderReferrer ?? MULTISIG_FEE_COLLECTOR,
          feeIn,
          feeOut
        }
      ]
    })

    if (!isBigInt(result)) {
      throw new Error('Invalid response format')
    }

    return {
      amountOut: result,
      swapParams: {
        ...params,
        allowance,
        feeIn,
        feeOut,
        tokenInPoolType,
        tokenOutPoolType,
        amountOutMinimum: calculateMinAmountWithSlippage(result)
      }
    }
  }

  async swap(params: SwapParams, isBatchSupported: boolean): Promise<HexString> {
    const walletClient = this.walletClient

    const {
      allowance,
      amountOutMinimum,
      tokenIn,
      amountIn,
      orderReferrer,
      recipient,
      feeIn,
      feeOut,
      tokenInPoolType,
      tokenOutPoolType,
      tokenOut
    } = params

    const amountOutMin = calculateMinAmountWithSlippage(amountOutMinimum)

    const approveContractCall = {
      address: tokenIn,
      abi: [
        {
          inputs: [
            { name: 'spender', type: 'address' },
            { name: 'amount', type: 'uint256' }
          ],
          name: 'approve',
          outputs: [{ name: '', type: 'bool' }],
          stateMutability: 'nonpayable',
          type: 'function'
        }
      ],
      functionName: 'approve',
      args: [SWAPPER_CONTRACT, amountIn]
    } as const

    const swapContractCall = {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      abi: SWAP_ABI as Abi,
      address: SWAPPER_CONTRACT,
      functionName: 'swap',
      args: [
        {
          tokenIn,
          tokenOut,
          tokenInPoolType,
          tokenOutPoolType,
          recipient: recipient ?? walletClient.account,
          amountIn,
          amountOutMin,
          orderReferrer: orderReferrer ?? MULTISIG_FEE_COLLECTOR,
          feeIn: feeIn ?? 0,
          feeOut: feeOut ?? 0
        }
      ]
    } as const

    const account = walletClient.account
    if (isNull(account)) {
      throw new Error('No account found')
    }

    if (isBatchSupported) {
      const result = await writeContracts(walletClient, {
        contracts: [
          // approve
          ...(tokenInPoolType !== TokenPoolType.WETH && allowance < amountIn
            ? [approveContractCall]
            : []),
          // swap
          swapContractCall
        ],
        account,
        chain: base
      })

      let status, receipts
      const extendedWalletClient = walletClient.extend(eip5792Actions())
      do {
        ;({ status, receipts } = await extendedWalletClient.getCallsStatus({
          id: result
        }))
        if (status !== 'CONFIRMED') {
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
      } while (status !== 'CONFIRMED')

      if (isNull(receipts) || receipts.length === 0) {
        throw new Error('Transaction failed')
      }

      const lastReceipt = receipts[receipts.length - 1]
      if (isNull(lastReceipt)) {
        throw new Error('Transaction failed')
      }

      if (isNull(lastReceipt.transactionHash)) {
        throw new Error('Transaction reverted')
      }

      return lastReceipt.transactionHash
    } else {
      if (tokenInPoolType !== TokenPoolType.WETH && allowance < amountIn) {
        const data = encodeFunctionData(approveContractCall)
        const txParams = {
          to: tokenIn,
          data,
          account,
          chain: base
        }

        const gas = ((await this.publicClient.estimateGas(txParams)) * 125n) / 100n

        const approveTx = await walletClient.sendTransaction({
          ...txParams,
          gas
        })

        await this.publicClient.waitForTransactionReceipt({
          hash: approveTx,
          confirmations: 2
        })
      }

      const data = encodeFunctionData(swapContractCall)

      const txParams = {
        to: SWAPPER_CONTRACT,
        data,
        account,
        chain: base
      }

      const gas = ((await this.publicClient.estimateGas(txParams)) * 125n) / 100n

      const tx = await walletClient.sendTransaction({
        ...txParams,
        gas
      })

      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash: tx,
        confirmations: 3
      })

      return receipt.transactionHash
    }
  }

  private resolvePoolOfMemecoin(memecoin: HydratedCoin): ResolveTokenPoolResponse {
    if (!memecoin.dexInitiated) {
      return { poolType: TokenPoolType.BondingCurve, poolFee: 0 }
    }

    switch (memecoin.dexKind) {
      case 'univ2':
        return { poolType: TokenPoolType.UniswapV2, poolFee: 0 }
      case 'univ3':
      case 'univ3-bonding':
        return { poolType: TokenPoolType.UniswapV3, poolFee: 10000 }
    }
  }

  private async resolveTokenWETHPool(token: EthAddress): Promise<ResolveTokenPoolResponse> {
    const feeTiers = [500, 3000, 10000]

    const poolPromises = feeTiers.map((fee) => this.uniswapV3.getWETHPoolLiquidity(token, fee))

    const v2Promise = this.uniswapV2.getWETHPoolLiquidity(token)

    const poolResults = await Promise.all([...poolPromises, v2Promise])

    const deepestPool = poolResults.reduce((max, pool) =>
      pool.liquidity > max.liquidity ? pool : max
    )

    if (deepestPool.liquidity === 0n) {
      throw new Error('No pool found')
    }

    return {
      poolType: deepestPool.poolType,
      poolFee: deepestPool.poolFee
    }
  }
}
