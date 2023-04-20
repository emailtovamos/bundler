import { JsonRpcProvider } from '@ethersproject/providers'
import { ethers } from 'ethers'
import { resolveProperties } from 'ethers/lib/utils'
import { UserOperationStruct } from '@account-abstraction/contracts'
import Debug from 'debug'
import { deepHexlify } from '@account-abstraction/utils'
import type { BaseContract, BigNumber, BigNumberish, BytesLike, CallOverrides, ContractTransaction, Overrides, PayableOverrides, PopulatedTransaction, Signer, utils } from "ethers";


const debug = Debug('aa.rpc')

export type UserOperationStructWithoutFee = {
  sender: string;
  nonce: BigNumberish;
  initCode: BytesLike;
  callData: BytesLike;
  callGasLimit: BigNumberish;
  verificationGasLimit: BigNumberish;
  preVerificationGas: BigNumberish;
  paymasterAndData: BytesLike;
  signature: string;
};

export class HttpRpcClient {
  private readonly userOpJsonRpcProvider: JsonRpcProvider

  initializing: Promise<void>

  constructor (
    readonly bundlerUrl: string,
    readonly entryPointAddress: string,
    readonly chainId: number
  ) {
    this.userOpJsonRpcProvider = new ethers.providers.JsonRpcProvider(this.bundlerUrl, {
      name: 'Connected bundler network',
      chainId
    })
    this.initializing = this.validateChainId()
  }

  async validateChainId (): Promise<void> {
    // validate chainId is in sync with expected chainid
    const chain = await this.userOpJsonRpcProvider.send('eth_chainId', [])
    const bundlerChain = parseInt(chain)
    if (bundlerChain !== this.chainId) {
      throw new Error(`bundler ${this.bundlerUrl} is on chainId ${bundlerChain}, but provider is on chainId ${this.chainId}`)
    }
  }

  

  /**
   * send a UserOperation to the bundler
   * @param userOp1
   * @return userOpHash the id of this operation, for getUserOperationTransaction
   */
  async sendUserOpToBundler (userOp1: UserOperationStructWithoutFee): Promise<string> {
    console.log("sendUserOpToBundler")
    console.log("userOp1: ", userOp1)
    await this.initializing
    console.log("initializing done...")
    
    const userOperationWithoutFee: UserOperationStructWithoutFee = {
      sender: userOp1.sender.toString(),
      nonce: userOp1.nonce.toLocaleString(),
      initCode: userOp1.initCode.toString(),
      callData: userOp1.callData.toString(),
      callGasLimit: userOp1.callGasLimit.toLocaleString(),
      verificationGasLimit: userOp1.verificationGasLimit.toLocaleString(),
      preVerificationGas: userOp1.preVerificationGas.toLocaleString(),
      paymasterAndData: userOp1.paymasterAndData.toString(),
      signature: userOp1.signature.toString(),
  };

    const hexifiedUserOp = deepHexlify(await resolveProperties(userOperationWithoutFee))
    const jsonRequestData: [UserOperationStruct, string] = [hexifiedUserOp, this.entryPointAddress]
    await this.printUserOperation('eth_sendUserOperation', jsonRequestData)

    console.log("about to send user operation to bundler..")
    

    await new Promise(f => setTimeout(f, 10000));
    function sleep(ms: number): Promise<void> {
      console.log("Starting to sleep")
      return new Promise(resolve => setTimeout(resolve, ms));
    }
    sleep(10000)

    return await this.userOpJsonRpcProvider
      .send('eth_sendUserOperation', [hexifiedUserOp, this.entryPointAddress])
  }

  async estimateUserOpGas (userOp1: Partial<UserOperationStruct>): Promise<string> {
    await this.initializing
    const hexifiedUserOp = deepHexlify(await resolveProperties(userOp1))
    const jsonRequestData: [UserOperationStruct, string] = [hexifiedUserOp, this.entryPointAddress]
    await this.printUserOperation('eth_estimateUserOperationGas', jsonRequestData)
    return await this.userOpJsonRpcProvider
      .send('eth_estimateUserOperationGas', [hexifiedUserOp, this.entryPointAddress])
  }

  private async printUserOperation (method: string, [userOp1, entryPointAddress]: [UserOperationStruct, string]): Promise<void> {
    const userOp = await resolveProperties(userOp1)
    debug('sending', method, {
      ...userOp
      // initCode: (userOp.initCode ?? '').length,
      // callData: (userOp.callData ?? '').length
    }, entryPointAddress)
  }
}
