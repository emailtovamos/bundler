import { ethers, BigNumber, BigNumberish, BytesLike } from 'ethers'
import { defaultAbiCoder, hexConcat, hexlify, keccak256, resolveProperties } from 'ethers/lib/utils'
import { abi as entryPointAbi } from '@account-abstraction/contracts/artifacts/IEntryPoint.json'

import { Provider } from '@ethersproject/providers'
import {
  EntryPoint, EntryPoint__factory,
  UserOperationStruct
} from '@account-abstraction/contracts'

import { TransactionDetailsForUserOp } from './TransactionDetailsForUserOp'
import { PaymasterAPI } from './PaymasterAPI'
import { getUserOpHash, NotPromise } from '@account-abstraction/utils'
import { calcPreVerificationGas, GasOverheads } from './calcPreVerificationGas'

const validateUserOpMethod = 'simulateValidation'
const UserOpType = entryPointAbi.find(entry => entry.name === validateUserOpMethod)?.inputs[0]
export function packUserOp (op: NotPromise<UserOperationStructWithoutFee>, forSignature = true): string {
  if (forSignature) {
    // lighter signature scheme (must match UserOperation#pack): do encode a zero-length signature, but strip afterwards the appended zero-length value
    const userOpType = {
      components: [
        {
          type: 'address',
          name: 'sender'
        },
        {
          type: 'uint256',
          name: 'nonce'
        },
        {
          type: 'bytes',
          name: 'initCode'
        },
        {
          type: 'bytes',
          name: 'callData'
        },
        {
          type: 'uint256',
          name: 'callGasLimit'
        },
        {
          type: 'uint256',
          name: 'verificationGasLimit'
        },
        {
          type: 'uint256',
          name: 'preVerificationGas'
        },
        {
          type: 'bytes',
          name: 'paymasterAndData'
        },
        {
          type: 'bytes',
          name: 'signature'
        }
      ],
      name: 'userOp',
      type: 'tuple'
    }
    // console.log('hard-coded userOpType', userOpType)
    // console.log('from ABI userOpType', UserOpType)
    let encoded = defaultAbiCoder.encode([userOpType as any], [{
      ...op,
      signature: '0x'
    }])
    // remove leading word (total length) and trailing word (zero-length signature)
    encoded = '0x' + encoded.slice(66, encoded.length - 64)
    return encoded
  }

  const typevalues = (UserOpType as any).components.map((c: { name: keyof typeof op, type: string }) => ({
    type: c.type,
    val: op[c.name]
  }))
  return encode(typevalues, forSignature)
}

function encode (typevalues: Array<{ type: string, val: any }>, forSignature: boolean): string {
  const types = typevalues.map(typevalue => typevalue.type === 'bytes' && forSignature ? 'bytes32' : typevalue.type)
  const values = typevalues.map((typevalue) => typevalue.type === 'bytes' && forSignature ? keccak256(typevalue.val) : typevalue.val)
  return defaultAbiCoder.encode(types, values)
}

export interface BaseApiParams {
  provider: Provider
  entryPointAddress: string
  accountAddress?: string
  overheads?: Partial<GasOverheads>
  paymasterAPI?: PaymasterAPI
}

export interface UserOpResult {
  transactionHash: string
  success: boolean
}

type UserOperationStructWithoutFee = {
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

/**
 * Base class for all Smart Wallet ERC-4337 Clients to implement.
 * Subclass should inherit 5 methods to support a specific wallet contract:
 *
 * - getAccountInitCode - return the value to put into the "initCode" field, if the account is not yet deployed. should create the account instance using a factory contract.
 * - getNonce - return current account's nonce value
 * - encodeExecute - encode the call from entryPoint through our account to the target contract.
 * - signUserOpHash - sign the hash of a UserOp.
 *
 * The user can use the following APIs:
 * - createUnsignedUserOp - given "target" and "calldata", fill userOp to perform that operation from the account.
 * - createSignedUserOp - helper to call the above createUnsignedUserOp, and then extract the userOpHash and sign it
 */
export abstract class BaseAccountAPI {
  private senderAddress!: string
  private isPhantom = true
  // entryPoint connected to "zero" address. allowed to make static calls (e.g. to getSenderAddress)
  private readonly entryPointView: EntryPoint

  provider: Provider
  overheads?: Partial<GasOverheads>
  entryPointAddress: string
  accountAddress?: string
  paymasterAPI?: PaymasterAPI

  /**
   * base constructor.
   * subclass SHOULD add parameters that define the owner (signer) of this wallet
   */
  protected constructor (params: BaseApiParams) {
    this.provider = params.provider
    this.overheads = params.overheads
    this.entryPointAddress = params.entryPointAddress
    this.accountAddress = params.accountAddress
    this.paymasterAPI = params.paymasterAPI

    // factory "connect" define the contract address. the contract "connect" defines the "from" address.
    this.entryPointView = EntryPoint__factory.connect(params.entryPointAddress, params.provider).connect(ethers.constants.AddressZero)
  }

  async init (): Promise<this> {
    if (await this.provider.getCode(this.entryPointAddress) === '0x') {
      throw new Error(`entryPoint not deployed at ${this.entryPointAddress}`)
    }

    await this.getAccountAddress()
    return this
  }

  /**
   * return the value to put into the "initCode" field, if the contract is not yet deployed.
   * this value holds the "factory" address, followed by this account's information
   */
  abstract getAccountInitCode (): Promise<string>

  /**
   * return current account's nonce.
   */
  abstract getNonce (): Promise<BigNumber>

  /**
   * encode the call from entryPoint through our account to the target contract.
   * @param target
   * @param value
   * @param data
   */
  abstract encodeExecute (target: string, value: BigNumberish, data: string): Promise<string>

  /**
   * sign a userOp's hash (userOpHash).
   * @param userOpHash
   */
  abstract signUserOpHash (userOpHash: string): Promise<string>

  /**
   * check if the contract is already deployed.
   */
  async checkAccountPhantom (): Promise<boolean> {
    if (!this.isPhantom) {
      // already deployed. no need to check anymore.
      return this.isPhantom
    }
    const senderAddressCode = await this.provider.getCode(this.getAccountAddress())
    if (senderAddressCode.length > 2) {
      // console.log(`SimpleAccount Contract already deployed at ${this.senderAddress}`)
      this.isPhantom = false
    } else {
      // console.log(`SimpleAccount Contract is NOT YET deployed at ${this.senderAddress} - working in "phantom account" mode.`)
    }
    return this.isPhantom
  }

  /**
   * calculate the account address even before it is deployed
   */
  async getCounterFactualAddress (): Promise<string> {
    const initCode = this.getAccountInitCode()
    // use entryPoint to query account address (factory can provide a helper method to do the same, but
    // this method attempts to be generic
    try {
      await this.entryPointView.callStatic.getSenderAddress(initCode)
    } catch (e: any) {
      return e.errorArgs.sender
    }
    throw new Error('must handle revert')
  }

  /**
   * return initCode value to into the UserOp.
   * (either deployment code, or empty hex if contract already deployed)
   */
  async getInitCode (): Promise<string> {
    if (await this.checkAccountPhantom()) {
      return await this.getAccountInitCode()
    }
    return '0x'
  }

  /**
   * return maximum gas used for verification.
   * NOTE: createUnsignedUserOp will add to this value the cost of creation, if the contract is not yet created.
   */
  async getVerificationGasLimit (): Promise<BigNumberish> {
    return 100000
  }

  /**
   * should cover cost of putting calldata on-chain, and some overhead.
   * actual overhead depends on the expected bundle size
   */
  async getPreVerificationGas (userOp: Partial<UserOperationStruct>): Promise<number> {
    const p = await resolveProperties(userOp)
    return calcPreVerificationGas(p, this.overheads)
  }

  /**
   * ABI-encode a user operation. used for calldata cost estimation
   */
  packUserOp (userOp: NotPromise<UserOperationStructWithoutFee>): string {
    return packUserOp(userOp, false)
  }

  async encodeUserOpCallDataAndGasLimit (detailsForUserOp: TransactionDetailsForUserOp): Promise<{ callData: string, callGasLimit: BigNumber }> {
    function parseNumber (a: any): BigNumber | null {
      if (a == null || a === '') return null
      return BigNumber.from(a.toString())
    }

    const value = parseNumber(detailsForUserOp.value) ?? BigNumber.from(0)
    const callData = await this.encodeExecute(detailsForUserOp.target, value, detailsForUserOp.data)

    const callGasLimit = parseNumber(detailsForUserOp.gasLimit) ?? await this.provider.estimateGas({
      from: this.entryPointAddress,
      to: this.getAccountAddress(),
      data: callData
    })

    return {
      callData,
      callGasLimit
    }
  }

  /**
   * return userOpHash for signing.
   * This value matches entryPoint.getUserOpHash (calculated off-chain, to avoid a view call)
   * @param userOp userOperation, (signature field ignored)
   */
   async getUserOpHash (userOp: UserOperationStructWithoutFee): Promise<string> {
    console.log("getUserOpHash ...1")
    console.log("userOp: ",userOp)
    // userOp.maxFeePerGas = BigNumber.from(0)
    // userOp.maxPriorityFeePerGas = BigNumber.from(0)
    userOp.nonce = BigNumber.from(1)
    userOp.preVerificationGas = BigNumber.from(45760)
    userOp.callGasLimit = BigNumber.from(100000000)
    
    const op = await resolveProperties(userOp)
    // todo change op here so that maxFeePerGas & maxPriorityFeePerGas aren't set
    // op.maxFeePerGas = nil

    console.log("getUserOpHash ...2")
    // const chainId = await this.provider.getNetwork().then(net => net.chainId)
    const chainId = 1337
    return this.getUserOpHash2(op, this.entryPointAddress, chainId)
  }

  async getUserOpHash2 (op: NotPromise<UserOperationStructWithoutFee>, entryPoint: string, chainId: number): Promise<string> {
    const userOpHash = keccak256(packUserOp(op, true))
    const enc = defaultAbiCoder.encode(
      ['bytes32', 'address', 'uint256'],
      [userOpHash, entryPoint, chainId])
    return keccak256(enc)
  }

  /**
   * return the account's address.
   * this value is valid even before deploying the contract.
   */
  async getAccountAddress (): Promise<string> {
    if (this.senderAddress == null) {
      if (this.accountAddress != null) {
        this.senderAddress = this.accountAddress
      } else {
        this.senderAddress = await this.getCounterFactualAddress()
      }
    }
    return this.senderAddress
  }

  async estimateCreationGas (initCode?: string): Promise<BigNumberish> {
    if (initCode == null || initCode === '0x') return 0
    const deployerAddress = initCode.substring(0, 42)
    const deployerCallData = '0x' + initCode.substring(42)
    return await this.provider.estimateGas({ to: deployerAddress, data: deployerCallData })
  }

  /**
   * create a UserOperation, filling all details (except signature)
   * - if account is not yet created, add initCode to deploy it.
   * - if gas or nonce are missing, read them from the chain (note that we can't fill gaslimit before the account is created)
   * @param info
   */
  async createUnsignedUserOp (info: TransactionDetailsForUserOp): Promise<UserOperationStructWithoutFee> {
    const {
      callData,
      callGasLimit
    } = await this.encodeUserOpCallDataAndGasLimit(info)
    const initCode = await this.getInitCode()

    const initGas = await this.estimateCreationGas(initCode)
    const verificationGasLimit = BigNumber.from(await this.getVerificationGasLimit())
      .add(initGas)

    let {
      maxFeePerGas,
      maxPriorityFeePerGas
    } = info
    if (maxFeePerGas == null || maxPriorityFeePerGas == null) {
      const feeData = await this.provider.getFeeData()
      if (maxFeePerGas == null) {
        maxFeePerGas = feeData.maxFeePerGas ?? undefined
      }
      if (maxPriorityFeePerGas == null) {
        maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? undefined
      }
    }
    maxFeePerGas = undefined
    maxPriorityFeePerGas = undefined
    console.log("maxFeePerGas set as undefined...")

    const partialUserOp: any = {
      sender: this.getAccountAddress(),
      nonce: info.nonce ?? this.getNonce(),
      initCode,
      callData,
      callGasLimit,
      verificationGasLimit,
      // maxFeePerGas,
      // maxPriorityFeePerGas,
      paymasterAndData: '0x'
    }

    let paymasterAndData: string | undefined
    if (this.paymasterAPI != null) {
      // fill (partial) preVerificationGas (all except the cost of the generated paymasterAndData)
      const userOpForPm = {
        ...partialUserOp,
        preVerificationGas: await this.getPreVerificationGas(partialUserOp)
      }
      paymasterAndData = await this.paymasterAPI.getPaymasterAndData(userOpForPm)
    }
    partialUserOp.paymasterAndData = paymasterAndData ?? '0x'
    return {
      ...partialUserOp,
      preVerificationGas: this.getPreVerificationGas(partialUserOp),
      signature: ''
    }
  }

  /**
   * Sign the filled userOp.
   * @param userOp the UserOperation to sign (with signature field ignored)
   */
  async signUserOp (userOp: UserOperationStructWithoutFee): Promise<UserOperationStructWithoutFee> {
    console.log("signUserOp...0")
    const userOpHash = await this.getUserOpHash(userOp)
    console.log("signUserOp...1")
    const signature = (await this.signUserOpHash(userOpHash)).toString()
    console.log("signUserOp...2")
    return {
      ...userOp,
      signature
    }
  }

  /**
   * helper method: create and sign a user operation.
   * @param info transaction details for the userOp
   */
  async createSignedUserOp (info: TransactionDetailsForUserOp): Promise<UserOperationStructWithoutFee> {
    console.log("createSignedUserOp...")
    return await this.signUserOp(await this.createUnsignedUserOp(info))
  }

  /**
   * get the transaction that has this userOpHash mined, or null if not found
   * @param userOpHash returned by sendUserOpToBundler (or by getUserOpHash..)
   * @param timeout stop waiting after this timeout
   * @param interval time to wait between polls.
   * @return the transactionHash this userOp was mined, or null if not found.
   */
  async getUserOpReceipt (userOpHash: string, timeout = 30000, interval = 5000): Promise<string | null> {
    const endtime = Date.now() + timeout
    while (Date.now() < endtime) {
      const events = await this.entryPointView.queryFilter(this.entryPointView.filters.UserOperationEvent(userOpHash))
      if (events.length > 0) {
        return events[0].transactionHash
      }
      await new Promise(resolve => setTimeout(resolve, interval))
    }
    return null
  }
}
