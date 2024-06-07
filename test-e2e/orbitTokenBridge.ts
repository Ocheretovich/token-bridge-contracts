import {
  L1Network,
  L1ToL2MessageGasEstimator,
  L1ToL2MessageStatus,
  L1TransactionReceipt,
  L2Network,
  L2TransactionReceipt,
} from '@arbitrum/sdk'
import { getBaseFee } from '@arbitrum/sdk/dist/lib/utils/lib'
import { JsonRpcProvider } from '@ethersproject/providers'
import { expect } from 'chai'
import { setupTokenBridgeInLocalEnv } from '../scripts/local-deployment/localDeploymentLib'
import {
  ERC20,
  ERC20__factory,
  IERC20Bridge__factory,
  IERC20__factory,
  IInbox__factory,
  IOwnable__factory,
  L1OrbitUSDCGateway__factory,
  L1GatewayRouter__factory,
  L1OrbitCustomGateway__factory,
  L1OrbitERC20Gateway__factory,
  L1OrbitGatewayRouter__factory,
  L1USDCGateway__factory,
  L2CustomGateway__factory,
  L2GatewayRouter__factory,
  L2USDCGateway__factory,
  MockL1Usdc__factory,
  ProxyAdmin__factory,
  TestArbCustomToken__factory,
  TestCustomTokenL1__factory,
  TestERC20,
  TestERC20__factory,
  TestOrbitCustomTokenL1__factory,
  TransparentUpgradeableProxy__factory,
  UpgradeExecutor__factory,
  IFiatTokenArbitrumOrbitV22__factory,
} from '../build/types'
import { defaultAbiCoder } from 'ethers/lib/utils'
import { BigNumber, Wallet, ethers } from 'ethers'
import { exit } from 'process'

const config = {
  parentUrl: 'http://localhost:8547',
  childUrl: 'http://localhost:3347',
}

const LOCALHOST_L3_OWNER_KEY =
  '0xecdf21cb41c65afb51f91df408b7656e2c8739a5877f2814add0afd780cc210e'

let parentProvider: JsonRpcProvider
let childProvider: JsonRpcProvider

let deployerL1Wallet: Wallet
let deployerL2Wallet: Wallet

let userL1Wallet: Wallet
let userL2Wallet: Wallet

let _l1Network: L1Network
let _l2Network: L2Network

let token: TestERC20
let l2Token: ERC20
let nativeToken: ERC20 | undefined

describe('orbitTokenBridge', () => {
  // configure orbit token bridge
  before(async function () {
    parentProvider = new ethers.providers.JsonRpcProvider(config.parentUrl)
    childProvider = new ethers.providers.JsonRpcProvider(config.childUrl)

    const testDevKey =
      '0xb6b15c8cb491557369f3c7d2c287b053eb229daa9c22138887752191c9520659'
    const testDevL1Wallet = new ethers.Wallet(testDevKey, parentProvider)
    const testDevL2Wallet = new ethers.Wallet(testDevKey, childProvider)

    const deployerKey = ethers.utils.sha256(
      ethers.utils.toUtf8Bytes('user_token_bridge_deployer')
    )
    deployerL1Wallet = new ethers.Wallet(deployerKey, parentProvider)
    deployerL2Wallet = new ethers.Wallet(deployerKey, childProvider)
    await (
      await testDevL1Wallet.sendTransaction({
        to: deployerL1Wallet.address,
        value: ethers.utils.parseEther('20.0'),
      })
    ).wait()
    await (
      await testDevL2Wallet.sendTransaction({
        to: deployerL2Wallet.address,
        value: ethers.utils.parseEther('20.0'),
      })
    ).wait()

    const { l1Network, l2Network } = await setupTokenBridgeInLocalEnv()

    _l1Network = l1Network
    _l2Network = l2Network

    // create user wallets and fund it
    const userKey = ethers.utils.sha256(ethers.utils.toUtf8Bytes('user_wallet'))
    userL1Wallet = new ethers.Wallet(userKey, parentProvider)
    userL2Wallet = new ethers.Wallet(userKey, childProvider)
    await (
      await deployerL1Wallet.sendTransaction({
        to: userL1Wallet.address,
        value: ethers.utils.parseEther('10.0'),
      })
    ).wait()
    await (
      await deployerL2Wallet.sendTransaction({
        to: userL2Wallet.address,
        value: ethers.utils.parseEther('10.0'),
      })
    ).wait()

    const nativeTokenAddress = await getFeeToken(
      l2Network.ethBridge.inbox,
      parentProvider
    )
    nativeToken =
      nativeTokenAddress === ethers.constants.AddressZero
        ? undefined
        : ERC20__factory.connect(nativeTokenAddress, userL1Wallet)

    if (nativeToken) {
      const supply = await nativeToken.balanceOf(deployerL1Wallet.address)
      await (
        await nativeToken
          .connect(deployerL1Wallet)
          .transfer(userL1Wallet.address, supply.div(10))
      ).wait()
    }
  })

  it('should have deployed token bridge contracts', async function () {
    // get router as entry point
    const l1Router = L1OrbitGatewayRouter__factory.connect(
      _l2Network.tokenBridge.l1GatewayRouter,
      parentProvider
    )

    expect((await l1Router.defaultGateway()).toLowerCase()).to.be.eq(
      _l2Network.tokenBridge.l1ERC20Gateway.toLowerCase()
    )
  })

  it('can deposit token via default gateway', async function () {
    // fund user to be able to pay retryable fees
    if (nativeToken) {
      await (
        await nativeToken
          .connect(deployerL1Wallet)
          .transfer(userL1Wallet.address, ethers.utils.parseEther('1000'))
      ).wait()
      nativeToken.connect(userL1Wallet)
    }

    // create token to be bridged
    const tokenFactory = await new TestERC20__factory(userL1Wallet).deploy()
    token = await tokenFactory.deployed()
    await (await token.mint()).wait()

    // snapshot state before
    const userTokenBalanceBefore = await token.balanceOf(userL1Wallet.address)

    const gatewayTokenBalanceBefore = await token.balanceOf(
      _l2Network.tokenBridge.l1ERC20Gateway
    )
    const userNativeTokenBalanceBefore = nativeToken
      ? await nativeToken.balanceOf(userL1Wallet.address)
      : await parentProvider.getBalance(userL1Wallet.address)
    const bridgeNativeTokenBalanceBefore = nativeToken
      ? await nativeToken.balanceOf(_l2Network.ethBridge.bridge)
      : await parentProvider.getBalance(_l2Network.ethBridge.bridge)

    // approve token
    const depositAmount = 350
    await (
      await token.approve(_l2Network.tokenBridge.l1ERC20Gateway, depositAmount)
    ).wait()

    // calculate retryable params
    const maxSubmissionCost = nativeToken
      ? BigNumber.from(0)
      : BigNumber.from(584000000000)
    const callhook = '0x'

    const gateway = L1OrbitERC20Gateway__factory.connect(
      _l2Network.tokenBridge.l1ERC20Gateway,
      userL1Wallet
    )
    const outboundCalldata = await gateway.getOutboundCalldata(
      token.address,
      userL1Wallet.address,
      userL2Wallet.address,
      depositAmount,
      callhook
    )

    const l1ToL2MessageGasEstimate = new L1ToL2MessageGasEstimator(
      childProvider
    )
    const retryableParams = await l1ToL2MessageGasEstimate.estimateAll(
      {
        from: userL1Wallet.address,
        to: userL2Wallet.address,
        l2CallValue: BigNumber.from(0),
        excessFeeRefundAddress: userL1Wallet.address,
        callValueRefundAddress: userL1Wallet.address,
        data: outboundCalldata,
      },
      await getBaseFee(parentProvider),
      parentProvider
    )

    const gasLimit = retryableParams.gasLimit.mul(60)
    const maxFeePerGas = retryableParams.maxFeePerGas
    const tokenTotalFeeAmount = gasLimit.mul(maxFeePerGas).mul(2)

    // approve fee amount
    if (nativeToken) {
      await (
        await nativeToken.approve(
          _l2Network.tokenBridge.l1ERC20Gateway,
          tokenTotalFeeAmount
        )
      ).wait()
    }

    // bridge it
    const userEncodedData = nativeToken
      ? defaultAbiCoder.encode(
          ['uint256', 'bytes', 'uint256'],
          [maxSubmissionCost, callhook, tokenTotalFeeAmount]
        )
      : defaultAbiCoder.encode(
          ['uint256', 'bytes'],
          [maxSubmissionCost, callhook]
        )

    const router = nativeToken
      ? L1OrbitGatewayRouter__factory.connect(
          _l2Network.tokenBridge.l1GatewayRouter,
          userL1Wallet
        )
      : L1GatewayRouter__factory.connect(
          _l2Network.tokenBridge.l1GatewayRouter,
          userL1Wallet
        )

    const depositTx = await router.outboundTransferCustomRefund(
      token.address,
      userL1Wallet.address,
      userL2Wallet.address,
      depositAmount,
      gasLimit,
      maxFeePerGas,
      userEncodedData,
      { value: nativeToken ? BigNumber.from(0) : tokenTotalFeeAmount }
    )

    // wait for L2 msg to be executed
    await waitOnL2Msg(depositTx)

    ///// checks

    const l2TokenAddress = await router.calculateL2TokenAddress(token.address)
    l2Token = ERC20__factory.connect(l2TokenAddress, childProvider)
    expect(await l2Token.balanceOf(userL2Wallet.address)).to.be.eq(
      depositAmount
    )

    const userTokenBalanceAfter = await token.balanceOf(userL1Wallet.address)
    expect(userTokenBalanceBefore.sub(userTokenBalanceAfter)).to.be.eq(
      depositAmount
    )

    const gatewayTokenBalanceAfter = await token.balanceOf(
      _l2Network.tokenBridge.l1ERC20Gateway
    )
    expect(gatewayTokenBalanceAfter.sub(gatewayTokenBalanceBefore)).to.be.eq(
      depositAmount
    )

    const userNativeTokenBalanceAfter = nativeToken
      ? await nativeToken.balanceOf(userL1Wallet.address)
      : await parentProvider.getBalance(userL1Wallet.address)
    if (nativeToken) {
      expect(
        userNativeTokenBalanceBefore.sub(userNativeTokenBalanceAfter)
      ).to.be.eq(tokenTotalFeeAmount)
    } else {
      expect(
        userNativeTokenBalanceBefore.sub(userNativeTokenBalanceAfter)
      ).to.be.gte(tokenTotalFeeAmount.toNumber())
    }

    const bridgeNativeTokenBalanceAfter = nativeToken
      ? await nativeToken.balanceOf(_l2Network.ethBridge.bridge)
      : await parentProvider.getBalance(_l2Network.ethBridge.bridge)
    expect(
      bridgeNativeTokenBalanceAfter.sub(bridgeNativeTokenBalanceBefore)
    ).to.be.eq(tokenTotalFeeAmount)
  })

  xit('can withdraw token via default gateway', async function () {
    // fund userL2Wallet so it can pay for L2 withdraw TX
    await depositNativeToL2()

    // snapshot state before
    const userL1TokenBalanceBefore = await token.balanceOf(userL1Wallet.address)
    const userL2TokenBalanceBefore = await l2Token.balanceOf(
      userL2Wallet.address
    )
    const l1GatewayTokenBalanceBefore = await token.balanceOf(
      _l2Network.tokenBridge.l1ERC20Gateway
    )
    const l2TokenSupplyBefore = await l2Token.totalSupply()

    // start withdrawal
    const withdrawalAmount = 250
    const l2Router = L2GatewayRouter__factory.connect(
      _l2Network.tokenBridge.l2GatewayRouter,
      userL2Wallet
    )
    const withdrawTx = await l2Router[
      'outboundTransfer(address,address,uint256,bytes)'
    ](token.address, userL1Wallet.address, withdrawalAmount, '0x')
    const withdrawReceipt = await withdrawTx.wait()
    const l2Receipt = new L2TransactionReceipt(withdrawReceipt)

    // wait until dispute period passes and withdrawal is ready for execution
    await sleep(5 * 1000)

    const messages = await l2Receipt.getL2ToL1Messages(userL1Wallet)
    const l2ToL1Msg = messages[0]
    const timeToWaitMs = 1000
    await l2ToL1Msg.waitUntilReadyToExecute(childProvider, timeToWaitMs)

    // execute on L1
    await (await l2ToL1Msg.execute(childProvider)).wait()

    //// checks
    const userL1TokenBalanceAfter = await token.balanceOf(userL1Wallet.address)
    expect(userL1TokenBalanceAfter.sub(userL1TokenBalanceBefore)).to.be.eq(
      withdrawalAmount
    )

    const userL2TokenBalanceAfter = await l2Token.balanceOf(
      userL2Wallet.address
    )
    expect(userL2TokenBalanceBefore.sub(userL2TokenBalanceAfter)).to.be.eq(
      withdrawalAmount
    )

    const l1GatewayTokenBalanceAfter = await token.balanceOf(
      _l2Network.tokenBridge.l1ERC20Gateway
    )
    expect(
      l1GatewayTokenBalanceBefore.sub(l1GatewayTokenBalanceAfter)
    ).to.be.eq(withdrawalAmount)

    const l2TokenSupplyAfter = await l2Token.totalSupply()
    expect(l2TokenSupplyBefore.sub(l2TokenSupplyAfter)).to.be.eq(
      withdrawalAmount
    )
  })

  it('can deposit token via custom gateway', async function () {
    // fund user to be able to pay retryable fees
    if (nativeToken) {
      await (
        await nativeToken
          .connect(deployerL1Wallet)
          .transfer(userL1Wallet.address, ethers.utils.parseEther('1000'))
      ).wait()
    }

    // create L1 custom token
    const customL1TokenFactory = nativeToken
      ? await new TestOrbitCustomTokenL1__factory(deployerL1Wallet).deploy(
          _l2Network.tokenBridge.l1CustomGateway,
          _l2Network.tokenBridge.l1GatewayRouter
        )
      : await new TestCustomTokenL1__factory(deployerL1Wallet).deploy(
          _l2Network.tokenBridge.l1CustomGateway,
          _l2Network.tokenBridge.l1GatewayRouter
        )
    const customL1Token = await customL1TokenFactory.deployed()
    await (await customL1Token.connect(userL1Wallet).mint()).wait()

    // create L2 custom token
    if (nativeToken) {
      await depositNativeToL2()
    }
    const customL2TokenFactory = await new TestArbCustomToken__factory(
      deployerL2Wallet
    ).deploy(_l2Network.tokenBridge.l2CustomGateway, customL1Token.address)
    const customL2Token = await customL2TokenFactory.deployed()

    // prepare custom gateway registration params
    const router = nativeToken
      ? L1OrbitGatewayRouter__factory.connect(
          _l2Network.tokenBridge.l1GatewayRouter,
          userL1Wallet
        )
      : L1GatewayRouter__factory.connect(
          _l2Network.tokenBridge.l1GatewayRouter,
          userL1Wallet
        )
    const l1ToL2MessageGasEstimate = new L1ToL2MessageGasEstimator(
      childProvider
    )

    const routerData =
      L2GatewayRouter__factory.createInterface().encodeFunctionData(
        'setGateway',
        [[customL1Token.address], [_l2Network.tokenBridge.l2CustomGateway]]
      )
    const routerRetryableParams = await l1ToL2MessageGasEstimate.estimateAll(
      {
        from: _l2Network.tokenBridge.l1GatewayRouter,
        to: _l2Network.tokenBridge.l2GatewayRouter,
        l2CallValue: BigNumber.from(0),
        excessFeeRefundAddress: userL1Wallet.address,
        callValueRefundAddress: userL1Wallet.address,
        data: routerData,
      },
      await getBaseFee(parentProvider),
      parentProvider
    )

    const gatewayData =
      L2CustomGateway__factory.createInterface().encodeFunctionData(
        'registerTokenFromL1',
        [[customL1Token.address], [customL2Token.address]]
      )
    const gwRetryableParams = await l1ToL2MessageGasEstimate.estimateAll(
      {
        from: _l2Network.tokenBridge.l1CustomGateway,
        to: _l2Network.tokenBridge.l2CustomGateway,
        l2CallValue: BigNumber.from(0),
        excessFeeRefundAddress: userL1Wallet.address,
        callValueRefundAddress: userL1Wallet.address,
        data: gatewayData,
      },
      await getBaseFee(parentProvider),
      parentProvider
    )

    // approve fee amount
    const valueForGateway = gwRetryableParams.deposit.mul(BigNumber.from(2))
    const valueForRouter = routerRetryableParams.deposit.mul(BigNumber.from(2))
    if (nativeToken) {
      await (
        await nativeToken.approve(
          customL1Token.address,
          valueForGateway.add(valueForRouter)
        )
      ).wait()
    }

    // do the custom gateway registration
    const receipt = await (
      await customL1Token
        .connect(userL1Wallet)
        .registerTokenOnL2(
          customL2Token.address,
          gwRetryableParams.maxSubmissionCost,
          routerRetryableParams.maxSubmissionCost,
          gwRetryableParams.gasLimit.mul(2),
          routerRetryableParams.gasLimit.mul(2),
          BigNumber.from(100000000),
          valueForGateway,
          valueForRouter,
          userL1Wallet.address,
          {
            value: nativeToken
              ? BigNumber.from(0)
              : valueForGateway.add(valueForRouter),
          }
        )
    ).wait()

    /// wait for execution of both tickets
    const l1TxReceipt = new L1TransactionReceipt(receipt)
    const messages = await l1TxReceipt.getL1ToL2Messages(childProvider)
    const messageResults = await Promise.all(
      messages.map(message => message.waitForStatus())
    )
    if (
      messageResults[0].status !== L1ToL2MessageStatus.REDEEMED ||
      messageResults[1].status !== L1ToL2MessageStatus.REDEEMED
    ) {
      console.log(
        `Retryable ticket (ID ${messages[0].retryableCreationId}) status: ${
          L1ToL2MessageStatus[messageResults[0].status]
        }`
      )
      console.log(
        `Retryable ticket (ID ${messages[1].retryableCreationId}) status: ${
          L1ToL2MessageStatus[messageResults[1].status]
        }`
      )
      exit()
    }

    // snapshot state before
    const userTokenBalanceBefore = await customL1Token.balanceOf(
      userL1Wallet.address
    )
    const gatewayTokenBalanceBefore = await customL1Token.balanceOf(
      _l2Network.tokenBridge.l1CustomGateway
    )
    const userNativeTokenBalanceBefore = nativeToken
      ? await nativeToken.balanceOf(userL1Wallet.address)
      : await parentProvider.getBalance(userL1Wallet.address)
    const bridgeNativeTokenBalanceBefore = nativeToken
      ? await nativeToken.balanceOf(_l2Network.ethBridge.bridge)
      : await parentProvider.getBalance(_l2Network.ethBridge.bridge)

    // approve token
    const depositAmount = 110
    await (
      await customL1Token
        .connect(userL1Wallet)
        .approve(_l2Network.tokenBridge.l1CustomGateway, depositAmount)
    ).wait()

    // calculate retryable params
    const maxSubmissionCost = 0
    const callhook = '0x'

    const gateway = L1OrbitCustomGateway__factory.connect(
      _l2Network.tokenBridge.l1CustomGateway,
      userL1Wallet
    )
    const outboundCalldata = await gateway.getOutboundCalldata(
      customL1Token.address,
      userL1Wallet.address,
      userL2Wallet.address,
      depositAmount,
      callhook
    )

    const retryableParams = await l1ToL2MessageGasEstimate.estimateAll(
      {
        from: userL1Wallet.address,
        to: userL2Wallet.address,
        l2CallValue: BigNumber.from(0),
        excessFeeRefundAddress: userL1Wallet.address,
        callValueRefundAddress: userL1Wallet.address,
        data: outboundCalldata,
      },
      await getBaseFee(parentProvider),
      parentProvider
    )

    const gasLimit = retryableParams.gasLimit.mul(40)
    const maxFeePerGas = retryableParams.maxFeePerGas
    const tokenTotalFeeAmount = gasLimit.mul(maxFeePerGas).mul(2)

    // approve fee amount
    if (nativeToken) {
      await (
        await nativeToken.approve(
          _l2Network.tokenBridge.l1CustomGateway,
          tokenTotalFeeAmount
        )
      ).wait()
    }

    // bridge it
    const userEncodedData = nativeToken
      ? defaultAbiCoder.encode(
          ['uint256', 'bytes', 'uint256'],
          [maxSubmissionCost, callhook, tokenTotalFeeAmount]
        )
      : defaultAbiCoder.encode(
          ['uint256', 'bytes'],
          [BigNumber.from(334400000000), callhook]
        )

    const depositTx = await router.outboundTransferCustomRefund(
      customL1Token.address,
      userL1Wallet.address,
      userL2Wallet.address,
      depositAmount,
      gasLimit,
      maxFeePerGas,
      userEncodedData,
      { value: nativeToken ? BigNumber.from(0) : tokenTotalFeeAmount }
    )

    // wait for L2 msg to be executed
    await waitOnL2Msg(depositTx)

    ///// checks
    expect(await router.getGateway(customL1Token.address)).to.be.eq(
      _l2Network.tokenBridge.l1CustomGateway
    )

    const l2TokenAddress = await router.calculateL2TokenAddress(
      customL1Token.address
    )

    l2Token = ERC20__factory.connect(l2TokenAddress, childProvider)
    expect(await l2Token.balanceOf(userL2Wallet.address)).to.be.eq(
      depositAmount
    )

    const userTokenBalanceAfter = await customL1Token.balanceOf(
      userL1Wallet.address
    )
    expect(userTokenBalanceBefore.sub(userTokenBalanceAfter)).to.be.eq(
      depositAmount
    )

    const gatewayTokenBalanceAfter = await customL1Token.balanceOf(
      _l2Network.tokenBridge.l1CustomGateway
    )
    expect(gatewayTokenBalanceAfter.sub(gatewayTokenBalanceBefore)).to.be.eq(
      depositAmount
    )

    const userNativeTokenBalanceAfter = nativeToken
      ? await nativeToken.balanceOf(userL1Wallet.address)
      : await parentProvider.getBalance(userL1Wallet.address)
    if (nativeToken) {
      expect(
        userNativeTokenBalanceBefore.sub(userNativeTokenBalanceAfter)
      ).to.be.eq(tokenTotalFeeAmount)
    } else {
      expect(
        userNativeTokenBalanceBefore.sub(userNativeTokenBalanceAfter)
      ).to.be.gte(tokenTotalFeeAmount.toNumber())
    }
    const bridgeNativeTokenBalanceAfter = nativeToken
      ? await nativeToken.balanceOf(_l2Network.ethBridge.bridge)
      : await parentProvider.getBalance(_l2Network.ethBridge.bridge)
    expect(
      bridgeNativeTokenBalanceAfter.sub(bridgeNativeTokenBalanceBefore)
    ).to.be.eq(tokenTotalFeeAmount)
  })

  it('can upgrade from bridged USDC to native USDC when eth is native token', async function () {
    /// test applicable only for eth based chains
    if (nativeToken) {
      return
    }

    /// create new L1 usdc gateway behind proxy
    const proxyAdminFac = await new ProxyAdmin__factory(
      deployerL1Wallet
    ).deploy()
    const proxyAdmin = await proxyAdminFac.deployed()
    const l1USDCCustomGatewayFactory = await new L1USDCGateway__factory(
      deployerL1Wallet
    ).deploy()
    const l1USDCCustomGatewayLogic = await l1USDCCustomGatewayFactory.deployed()
    const tupFactory = await new TransparentUpgradeableProxy__factory(
      deployerL1Wallet
    ).deploy(l1USDCCustomGatewayLogic.address, proxyAdmin.address, '0x')
    const tup = await tupFactory.deployed()
    const l1USDCCustomGateway = L1USDCGateway__factory.connect(
      tup.address,
      deployerL1Wallet
    )
    console.log('L1USDCGateway address: ', l1USDCCustomGateway.address)

    /// create new L2 usdc gateway behind proxy
    const proxyAdminL2Fac = await new ProxyAdmin__factory(
      deployerL2Wallet
    ).deploy()
    const proxyAdminL2 = await proxyAdminL2Fac.deployed()
    const l2USDCCustomGatewayFactory = await new L2USDCGateway__factory(
      deployerL2Wallet
    ).deploy()
    const l2USDCCustomGatewayLogic = await l2USDCCustomGatewayFactory.deployed()
    const tupL2Factory = await new TransparentUpgradeableProxy__factory(
      deployerL2Wallet
    ).deploy(l2USDCCustomGatewayLogic.address, proxyAdminL2.address, '0x')
    const tupL2 = await tupL2Factory.deployed()
    const l2USDCCustomGateway = L2USDCGateway__factory.connect(
      tupL2.address,
      deployerL2Wallet
    )
    console.log('L2USDCGateway address: ', l2USDCCustomGateway.address)

    /// create l1 usdc behind proxy
    const l1UsdcFactory = await new MockL1Usdc__factory(
      deployerL1Wallet
    ).deploy()
    const l1UsdcLogic = await l1UsdcFactory.deployed()
    const tupL1UsdcFactory = await new TransparentUpgradeableProxy__factory(
      deployerL1Wallet
    ).deploy(l1UsdcLogic.address, proxyAdmin.address, '0x')
    const tupL1Usdc = await tupL1UsdcFactory.deployed()
    const l1Usdc = MockL1Usdc__factory.connect(
      tupL1Usdc.address,
      deployerL1Wallet
    )
    await (await l1Usdc.initialize()).wait()
    console.log('L1 USDC address: ', l1Usdc.address)

    /// create l2 usdc behind proxy
    const l2UsdcLogic = await _deployBridgedUsdcToken(deployerL2Wallet)
    const tupL2UsdcFactory = await new TransparentUpgradeableProxy__factory(
      deployerL2Wallet
    ).deploy(l2UsdcLogic.address, proxyAdminL2.address, '0x')
    const tupL2Usdc = await tupL2UsdcFactory.deployed()
    const l2UsdcInit = IFiatTokenArbitrumOrbitV22__factory.connect(
      tupL2Usdc.address,
      deployerL2Wallet
    )
    const masterMinter = deployerL2Wallet
    await (
      await l2UsdcInit.initialize(
        'USDC token',
        'USDC.e',
        'USD',
        6,
        masterMinter.address,
        ethers.Wallet.createRandom().address,
        ethers.Wallet.createRandom().address,
        deployerL2Wallet.address
      )
    ).wait()
    await (await l2UsdcInit.initializeV2('USDC')).wait()
    await (
      await l2UsdcInit.initializeV2_1(ethers.Wallet.createRandom().address)
    ).wait()
    await (await l2UsdcInit.initializeV2_2([], 'USDC.e')).wait()
    await (
      await l2UsdcInit.initializeArbitrumOrbit(
        l2USDCCustomGateway.address,
        l1Usdc.address
      )
    ).wait()

    await (
      await l2UsdcInit
        .connect(masterMinter)
        .configureMinter(
          l2USDCCustomGateway.address,
          ethers.constants.MaxUint256
        )
    ).wait()
    const l2Usdc = IERC20__factory.connect(l2UsdcInit.address, deployerL2Wallet)
    console.log('L2 USDC address: ', l2Usdc.address)

    /// initialize gateways
    await (
      await l1USDCCustomGateway.initialize(
        l2USDCCustomGateway.address,
        _l2Network.tokenBridge.l1GatewayRouter,
        _l2Network.ethBridge.inbox,
        l1Usdc.address,
        l2Usdc.address,
        deployerL1Wallet.address
      )
    ).wait()
    console.log('L1 USDC custom gateway initialized')

    await (
      await l2USDCCustomGateway.initialize(
        l1USDCCustomGateway.address,
        _l2Network.tokenBridge.l2GatewayRouter,
        l1Usdc.address,
        l2Usdc.address,
        deployerL2Wallet.address
      )
    ).wait()
    console.log('L2 USDC custom gateway initialized')

    /// register USDC custom gateway
    const router = L1GatewayRouter__factory.connect(
      _l2Network.tokenBridge.l1GatewayRouter,
      deployerL1Wallet
    )
    const l2Router = L2GatewayRouter__factory.connect(
      _l2Network.tokenBridge.l2GatewayRouter,
      deployerL2Wallet
    )
    const maxGas = BigNumber.from(500000)
    const gasPriceBid = BigNumber.from(200000000)
    let maxSubmissionCost = BigNumber.from(257600000000)
    const registrationCalldata = router.interface.encodeFunctionData(
      'setGateways',
      [
        [l1Usdc.address],
        [l1USDCCustomGateway.address],
        maxGas,
        gasPriceBid,
        maxSubmissionCost,
      ]
    )
    const rollupOwner = new Wallet(LOCALHOST_L3_OWNER_KEY, parentProvider)
    const upExec = UpgradeExecutor__factory.connect(
      await IOwnable__factory.connect(
        _l2Network.ethBridge.rollup,
        deployerL1Wallet
      ).owner(),
      rollupOwner
    )
    const gwRegistrationTx = await upExec.executeCall(
      router.address,
      registrationCalldata,
      {
        value: maxGas.mul(gasPriceBid).add(maxSubmissionCost),
      }
    )
    await waitOnL2Msg(gwRegistrationTx)
    console.log('USDC custom gateway registered')

    /// check gateway registration
    expect(await router.getGateway(l1Usdc.address)).to.be.eq(
      l1USDCCustomGateway.address
    )
    expect(await l1USDCCustomGateway.depositsPaused()).to.be.eq(false)
    expect(await l2Router.getGateway(l1Usdc.address)).to.be.eq(
      l2USDCCustomGateway.address
    )
    expect(await l2USDCCustomGateway.withdrawalsPaused()).to.be.eq(false)

    /// do a deposit
    const depositAmount = ethers.utils.parseEther('2')
    await (await l1Usdc.transfer(userL1Wallet.address, depositAmount)).wait()
    await (
      await l1Usdc
        .connect(userL1Wallet)
        .approve(l1USDCCustomGateway.address, depositAmount)
    ).wait()
    maxSubmissionCost = BigNumber.from(334400000000)
    const depositTx = await router
      .connect(userL1Wallet)
      .outboundTransferCustomRefund(
        l1Usdc.address,
        userL2Wallet.address,
        userL2Wallet.address,
        depositAmount,
        maxGas,
        gasPriceBid,
        defaultAbiCoder.encode(['uint256', 'bytes'], [maxSubmissionCost, '0x']),
        { value: maxGas.mul(gasPriceBid).add(maxSubmissionCost) }
      )
    await waitOnL2Msg(depositTx)
    expect(await l2Usdc.balanceOf(userL2Wallet.address)).to.be.eq(depositAmount)
    expect(await l1Usdc.balanceOf(l1USDCCustomGateway.address)).to.be.eq(
      depositAmount
    )
    console.log('Deposited USDC')

    /// pause deposits
    await (await l1USDCCustomGateway.pauseDeposits()).wait()
    expect(await l1USDCCustomGateway.depositsPaused()).to.be.eq(true)

    /// pause withdrawals
    await (await l2USDCCustomGateway.pauseWithdrawals()).wait()
    expect(await l2USDCCustomGateway.withdrawalsPaused()).to.be.eq(true)

    /// transfer ownership to circle
    const circleWallet = ethers.Wallet.createRandom().connect(parentProvider)
    await (
      await deployerL1Wallet.sendTransaction({
        to: circleWallet.address,
        value: ethers.utils.parseEther('1'),
      })
    ).wait()

    await (await l1Usdc.setOwner(circleWallet.address)).wait()
    await (await l1USDCCustomGateway.setOwner(circleWallet.address)).wait()
    console.log('L1 USDC and L1 USDC gateway ownership transferred to circle')

    /// circle checks that deposits are paused, all in-flight deposits and withdrawals are processed

    /// add minter rights to usdc gateway so it can burn USDC
    await (
      await l1Usdc.connect(circleWallet).addMinter(l1USDCCustomGateway.address)
    ).wait()
    console.log('Minter rights added to USDC gateway')

    /// burn USDC
    await (
      await l1USDCCustomGateway.connect(circleWallet).burnLockedUSDC()
    ).wait()
    expect(await l1Usdc.balanceOf(l1USDCCustomGateway.address)).to.be.eq(0)
    expect(await l2Usdc.balanceOf(userL2Wallet.address)).to.be.eq(depositAmount)
    console.log('USDC burned')
  })

  it('can upgrade from bridged USDC to native USDC when fee token is used', async function () {
    /// test applicable only for fee token based chains
    if (!nativeToken) {
      return
    }

    /// create new L1 usdc gateway behind proxy
    const proxyAdminFac = await new ProxyAdmin__factory(
      deployerL1Wallet
    ).deploy()
    const proxyAdmin = await proxyAdminFac.deployed()
    const l1USDCCustomGatewayFactory =
      await new L1OrbitUSDCGateway__factory(deployerL1Wallet).deploy()
    const l1USDCCustomGatewayLogic = await l1USDCCustomGatewayFactory.deployed()
    const tupFactory = await new TransparentUpgradeableProxy__factory(
      deployerL1Wallet
    ).deploy(l1USDCCustomGatewayLogic.address, proxyAdmin.address, '0x')
    const tup = await tupFactory.deployed()
    const l1USDCCustomGateway = L1USDCGateway__factory.connect(
      tup.address,
      deployerL1Wallet
    )
    console.log('L1USDCGateway address: ', l1USDCCustomGateway.address)

    /// create new L2 usdc gateway behind proxy
    const proxyAdminL2Fac = await new ProxyAdmin__factory(
      deployerL2Wallet
    ).deploy()
    const proxyAdminL2 = await proxyAdminL2Fac.deployed()
    const l2USDCCustomGatewayFactory = await new L2USDCGateway__factory(
      deployerL2Wallet
    ).deploy()
    const l2USDCCustomGatewayLogic = await l2USDCCustomGatewayFactory.deployed()
    const tupL2Factory = await new TransparentUpgradeableProxy__factory(
      deployerL2Wallet
    ).deploy(l2USDCCustomGatewayLogic.address, proxyAdminL2.address, '0x')
    const tupL2 = await tupL2Factory.deployed()
    const l2USDCCustomGateway = L2USDCGateway__factory.connect(
      tupL2.address,
      deployerL2Wallet
    )
    console.log('L2USDCGateway address: ', l2USDCCustomGateway.address)

    /// create l1 usdc behind proxy
    const l1UsdcFactory = await new MockL1Usdc__factory(
      deployerL1Wallet
    ).deploy()
    const l1UsdcLogic = await l1UsdcFactory.deployed()
    const tupL1UsdcFactory = await new TransparentUpgradeableProxy__factory(
      deployerL1Wallet
    ).deploy(l1UsdcLogic.address, proxyAdmin.address, '0x')
    const tupL1Usdc = await tupL1UsdcFactory.deployed()
    const l1Usdc = MockL1Usdc__factory.connect(
      tupL1Usdc.address,
      deployerL1Wallet
    )
    await (await l1Usdc.initialize()).wait()
    console.log('L1 USDC address: ', l1Usdc.address)

    /// create l2 usdc behind proxy
    const l2UsdcLogic = await _deployBridgedUsdcToken(deployerL2Wallet)
    const tupL2UsdcFactory = await new TransparentUpgradeableProxy__factory(
      deployerL2Wallet
    ).deploy(l2UsdcLogic.address, proxyAdminL2.address, '0x')
    const tupL2Usdc = await tupL2UsdcFactory.deployed()
    const l2UsdcInit = IFiatTokenArbitrumOrbitV22__factory.connect(
      tupL2Usdc.address,
      deployerL2Wallet
    )
    const masterMinter = deployerL2Wallet
    await (
      await l2UsdcInit.initialize(
        'USDC token',
        'USDC.e',
        'USD',
        6,
        masterMinter.address,
        ethers.Wallet.createRandom().address,
        ethers.Wallet.createRandom().address,
        deployerL2Wallet.address
      )
    ).wait()
    await (await l2UsdcInit.initializeV2('USDC')).wait()
    await (
      await l2UsdcInit.initializeV2_1(ethers.Wallet.createRandom().address)
    ).wait()
    await (await l2UsdcInit.initializeV2_2([], 'USDC.e')).wait()
    await (
      await l2UsdcInit.initializeArbitrumOrbit(
        l2USDCCustomGateway.address,
        l1Usdc.address
      )
    ).wait()
    await (
      await l2UsdcInit
        .connect(masterMinter)
        .configureMinter(
          l2USDCCustomGateway.address,
          ethers.constants.MaxUint256
        )
    ).wait()
    const l2Usdc = IERC20__factory.connect(l2UsdcInit.address, deployerL2Wallet)
    console.log('L2 USDC address: ', l2Usdc.address)

    /// initialize gateways
    await (
      await l1USDCCustomGateway.initialize(
        l2USDCCustomGateway.address,
        _l2Network.tokenBridge.l1GatewayRouter,
        _l2Network.ethBridge.inbox,
        l1Usdc.address,
        l2Usdc.address,
        deployerL1Wallet.address
      )
    ).wait()
    console.log('L1 USDC custom gateway initialized')

    await (
      await l2USDCCustomGateway.initialize(
        l1USDCCustomGateway.address,
        _l2Network.tokenBridge.l2GatewayRouter,
        l1Usdc.address,
        l2Usdc.address,
        deployerL2Wallet.address
      )
    ).wait()
    console.log('L2 USDC custom gateway initialized')

    /// register USDC custom gateway
    const router = L1OrbitGatewayRouter__factory.connect(
      _l2Network.tokenBridge.l1GatewayRouter,
      deployerL1Wallet
    )
    const l2Router = L2GatewayRouter__factory.connect(
      _l2Network.tokenBridge.l2GatewayRouter,
      deployerL2Wallet
    )
    const maxGas = BigNumber.from(500000)
    const gasPriceBid = BigNumber.from(200000000)
    const totalFeeTokenAmount = maxGas.mul(gasPriceBid)
    const maxSubmissionCost = BigNumber.from(0)

    // prefund inbox to pay for registration
    await (
      await nativeToken
        .connect(deployerL1Wallet)
        .transfer(_l2Network.ethBridge.inbox, totalFeeTokenAmount)
    ).wait()

    const registrationCalldata = (router.interface as any).encodeFunctionData(
      'setGateways(address[],address[],uint256,uint256,uint256,uint256)',
      [
        [l1Usdc.address],
        [l1USDCCustomGateway.address],
        maxGas,
        gasPriceBid,
        maxSubmissionCost,
        totalFeeTokenAmount,
      ]
    )
    const rollupOwner = new Wallet(LOCALHOST_L3_OWNER_KEY, parentProvider)

    // approve fee amount
    console.log('Approving fee amount')
    await (
      await nativeToken
        .connect(rollupOwner)
        .approve(l1USDCCustomGateway.address, totalFeeTokenAmount)
    ).wait()

    const upExec = UpgradeExecutor__factory.connect(
      await IOwnable__factory.connect(
        _l2Network.ethBridge.rollup,
        deployerL1Wallet
      ).owner(),
      rollupOwner
    )
    const gwRegistrationTx = await upExec.executeCall(
      router.address,
      registrationCalldata
    )
    await waitOnL2Msg(gwRegistrationTx)
    console.log('USDC custom gateway registered')

    /// check gateway registration
    expect(await router.getGateway(l1Usdc.address)).to.be.eq(
      l1USDCCustomGateway.address
    )
    expect(await l1USDCCustomGateway.depositsPaused()).to.be.eq(false)
    expect(await l2Router.getGateway(l1Usdc.address)).to.be.eq(
      l2USDCCustomGateway.address
    )
    expect(await l2USDCCustomGateway.withdrawalsPaused()).to.be.eq(false)

    /// do a deposit
    const depositAmount = ethers.utils.parseEther('2')
    await (await l1Usdc.transfer(userL1Wallet.address, depositAmount)).wait()
    await (
      await l1Usdc
        .connect(userL1Wallet)
        .approve(l1USDCCustomGateway.address, depositAmount)
    ).wait()

    // approve fee amount
    await (
      await nativeToken
        .connect(userL1Wallet)
        .approve(l1USDCCustomGateway.address, totalFeeTokenAmount)
    ).wait()

    const depositTx = await router
      .connect(userL1Wallet)
      .outboundTransferCustomRefund(
        l1Usdc.address,
        userL2Wallet.address,
        userL2Wallet.address,
        depositAmount,
        maxGas,
        gasPriceBid,
        defaultAbiCoder.encode(
          ['uint256', 'bytes', 'uint256'],
          [maxSubmissionCost, '0x', totalFeeTokenAmount]
        )
      )
    await waitOnL2Msg(depositTx)
    expect(await l2Usdc.balanceOf(userL2Wallet.address)).to.be.eq(depositAmount)
    expect(await l1Usdc.balanceOf(l1USDCCustomGateway.address)).to.be.eq(
      depositAmount
    )
    console.log('Deposited USDC')

    /// pause deposits
    await (await l1USDCCustomGateway.pauseDeposits()).wait()
    expect(await l1USDCCustomGateway.depositsPaused()).to.be.eq(true)

    /// pause withdrawals
    await (await l2USDCCustomGateway.pauseWithdrawals()).wait()
    expect(await l2USDCCustomGateway.withdrawalsPaused()).to.be.eq(true)

    /// transfer ownership to circle
    const circleWallet = ethers.Wallet.createRandom().connect(parentProvider)
    await (
      await deployerL1Wallet.sendTransaction({
        to: circleWallet.address,
        value: ethers.utils.parseEther('1'),
      })
    ).wait()

    await (await l1Usdc.setOwner(circleWallet.address)).wait()
    await (await l1USDCCustomGateway.setOwner(circleWallet.address)).wait()
    console.log('L1 USDC and L1 USDC gateway ownership transferred to circle')

    /// circle checks that deposits are paused, all in-flight deposits and withdrawals are processed

    /// add minter rights to usdc gateway so it can burn USDC
    await (
      await l1Usdc.connect(circleWallet).addMinter(l1USDCCustomGateway.address)
    ).wait()
    console.log('Minter rights added to USDC gateway')

    /// burn USDC
    await (
      await l1USDCCustomGateway.connect(circleWallet).burnLockedUSDC()
    ).wait()
    expect(await l1Usdc.balanceOf(l1USDCCustomGateway.address)).to.be.eq(0)
    expect(await l2Usdc.balanceOf(userL2Wallet.address)).to.be.eq(depositAmount)
    console.log('USDC burned')
  })
})

/**
 * helper function to fund user wallet on L2
 */
async function depositNativeToL2() {
  /// deposit tokens
  const amountToDeposit = ethers.utils.parseEther('2.0')
  await (
    await nativeToken!
      .connect(userL1Wallet)
      .approve(_l2Network.ethBridge.inbox, amountToDeposit)
  ).wait()

  const depositFuncSig = {
    name: 'depositERC20',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'amount',
        type: 'uint256',
      },
    ],
  }
  const inbox = new ethers.Contract(
    _l2Network.ethBridge.inbox,
    [depositFuncSig],
    userL1Wallet
  )

  const depositTx = await inbox.depositERC20(amountToDeposit)

  // wait for deposit to be processed
  const depositRec = await L1TransactionReceipt.monkeyPatchEthDepositWait(
    depositTx
  ).wait()
  await depositRec.waitForL2(childProvider)
}

async function waitOnL2Msg(tx: ethers.ContractTransaction) {
  const retryableReceipt = await tx.wait()
  const l1TxReceipt = new L1TransactionReceipt(retryableReceipt)
  const messages = await l1TxReceipt.getL1ToL2Messages(childProvider)

  // 1 msg expected
  const messageResult = await messages[0].waitForStatus()
  const status = messageResult.status
  expect(status).to.be.eq(L1ToL2MessageStatus.REDEEMED)
}

const getFeeToken = async (inbox: string, parentProvider: any) => {
  const bridge = await IInbox__factory.connect(inbox, parentProvider).bridge()

  let feeToken = ethers.constants.AddressZero

  try {
    feeToken = await IERC20Bridge__factory.connect(
      bridge,
      parentProvider
    ).nativeToken()
  } catch {}

  return feeToken
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function _deployBridgedUsdcToken(deployer: Wallet) {
  /// deploy library
  const sigCheckerLibBytecode =
    '6106cd610026600b82828239805160001a60731461001957fe5b30600052607381538281f3fe73000000000000000000000000000000000000000030146080604052600436106100355760003560e01c80636ccea6521461003a575b600080fd5b6101026004803603606081101561005057600080fd5b73ffffffffffffffffffffffffffffffffffffffff8235169160208101359181019060608101604082013564010000000081111561008d57600080fd5b82018360208201111561009f57600080fd5b803590602001918460018302840111640100000000831117156100c157600080fd5b91908080601f016020809104026020016040519081016040528093929190818152602001838380828437600092019190915250929550610116945050505050565b604080519115158252519081900360200190f35b600061012184610179565b610164578373ffffffffffffffffffffffffffffffffffffffff16610146848461017f565b73ffffffffffffffffffffffffffffffffffffffff16149050610172565b61016f848484610203565b90505b9392505050565b3b151590565b600081516041146101db576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260238152602001806106296023913960400191505060405180910390fd5b60208201516040830151606084015160001a6101f98682858561042d565b9695505050505050565b60008060608573ffffffffffffffffffffffffffffffffffffffff16631626ba7e60e01b86866040516024018083815260200180602001828103825283818151815260200191508051906020019080838360005b8381101561026f578181015183820152602001610257565b50505050905090810190601f16801561029c5780820380516001836020036101000a031916815260200191505b50604080517fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe08184030181529181526020820180517bffffffffffffffffffffffffffffffffffffffffffffffffffffffff167fffffffff000000000000000000000000000000000000000000000000000000009098169790971787525181519196909550859450925090508083835b6020831061036957805182527fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0909201916020918201910161032c565b6001836020036101000a038019825116818451168082178552505050505050905001915050600060405180830381855afa9150503d80600081146103c9576040519150601f19603f3d011682016040523d82523d6000602084013e6103ce565b606091505b50915091508180156103e257506020815110155b80156101f9575080517f1626ba7e00000000000000000000000000000000000000000000000000000000906020808401919081101561042057600080fd5b5051149695505050505050565b60007f7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a08211156104a8576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260268152602001806106726026913960400191505060405180910390fd5b8360ff16601b141580156104c057508360ff16601c14155b15610516576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040180806020018281038252602681526020018061064c6026913960400191505060405180910390fd5b600060018686868660405160008152602001604052604051808581526020018460ff1681526020018381526020018281526020019450505050506020604051602081039080840390855afa158015610572573d6000803e3d6000fd5b50506040517fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0015191505073ffffffffffffffffffffffffffffffffffffffff811661061f57604080517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601c60248201527f45435265636f7665723a20696e76616c6964207369676e617475726500000000604482015290519081900360640190fd5b9594505050505056fe45435265636f7665723a20696e76616c6964207369676e6174757265206c656e67746845435265636f7665723a20696e76616c6964207369676e6174757265202776272076616c756545435265636f7665723a20696e76616c6964207369676e6174757265202773272076616c7565a2646970667358221220fc883ef3b50f607958f5dc584d21cf2984d25712b89b5e11c0d53a81068ace3664736f6c634300060c0033'
  const sigCheckerFactory = new ethers.ContractFactory(
    [],
    sigCheckerLibBytecode,
    deployer
  )
  const sigCheckerLib = await sigCheckerFactory.deploy()

  // prepare bridged usdc bytecode
  const bytecodeWithPlaceholder: string =
    '0x60806040526001805460ff60a01b191690556000600b553480156200002357600080fd5b506200002f3362000035565b62000057565b600080546001600160a01b0319166001600160a01b0392909216919091179055565b61502e80620000676000396000f3fe608060405234801561001057600080fd5b50600436106103a45760003560e01c80638a6db9c3116101e9578063b7b728991161010f578063dd62ed3e116100ad578063ef55bec61161007c578063ef55bec614611069578063f2fde38b146110c8578063f9f92be4146110ee578063fe575a8714611114576103a4565b8063dd62ed3e14610fa8578063e3ee160e14610fd6578063e5a6b10f14611035578063e94a01021461103d576103a4565b8063cf092995116100e9578063cf09299514610e08578063d505accf14610edf578063d608ea6414610f30578063d916948714610fa0576103a4565b8063b7b7289914610d3d578063bd10243014610df8578063c2eeeebd14610e00576103a4565b8063a0cc6a6811610187578063aa20e1e411610156578063aa20e1e414610c95578063aa271e1a14610cbb578063ad38bf2214610ce1578063b2118a8d14610d07576103a4565b8063a0cc6a6814610c07578063a297ea5e14610c0f578063a457c2d714610c3d578063a9059cbb14610c69576103a4565b80638fa74a0e116101c35780638fa74a0e14610b2457806395d89b4114610b2c5780639fd0506d14610b345780639fd5a6cf14610b3c576103a4565b80638a6db9c314610aca5780638c2a993e14610af05780638da5cb5b14610b1c576103a4565b80633f4ba83a116102ce5780635a049a701161026c5780637ecebe001161023b5780637ecebe00146109bd5780637f2eecc3146109e35780638456cb59146109eb57806388b7ab63146109f3576103a4565b80635a049a70146109225780635c975abb1461096357806370a082311461096b57806374f4f54714610991576103a4565b8063430239b4116102a8578063430239b4146108065780634e44d956146108c857806354fd4d50146108f4578063554bab3c146108fc576103a4565b80633f4ba83a146107b557806340c10f19146107bd57806342966c68146107e9576103a4565b80633092afd51161034657806335d99f351161031557806335d99f35146107555780633644e5151461077957806338a63183146107815780633950935114610789576103a4565b80633092afd51461052a57806330adf81f14610550578063313ce567146105585780633357162b14610576576103a4565b80631a895266116103825780631a8952661461048057806323b872dd146104a85780632ab60045146104de5780632fc81e0914610504576103a4565b806306fdde03146103a9578063095ea7b31461042657806318160ddd14610466575b600080fd5b6103b161113a565b6040805160208082528351818301528351919283929083019185019080838360005b838110156103eb5781810151838201526020016103d3565b50505050905090810190601f1680156104185780820380516001836020036101000a031916815260200191505b509250505060405180910390f35b6104526004803603604081101561043c57600080fd5b506001600160a01b0381351690602001356111e6565b604080519115158252519081900360200190f35b61046e61125c565b60408051918252519081900360200190f35b6104a66004803603602081101561049657600080fd5b50356001600160a01b0316611262565b005b610452600480360360608110156104be57600080fd5b506001600160a01b038135811691602081013590911690604001356112eb565b6104a6600480360360208110156104f457600080fd5b50356001600160a01b03166114ec565b6104a66004803603602081101561051a57600080fd5b50356001600160a01b03166115f2565b6104526004803603602081101561054057600080fd5b50356001600160a01b031661163c565b61046e6116e3565b610560611707565b6040805160ff9092168252519081900360200190f35b6104a6600480360361010081101561058d57600080fd5b8101906020810181356401000000008111156105a857600080fd5b8201836020820111156105ba57600080fd5b803590602001918460018302840111640100000000831117156105dc57600080fd5b91908080601f016020809104026020016040519081016040528093929190818152602001838380828437600092019190915250929594936020810193503591505064010000000081111561062f57600080fd5b82018360208201111561064157600080fd5b8035906020019184600183028401116401000000008311171561066357600080fd5b91908080601f01602080910402602001604051908101604052809392919081815260200183838082843760009201919091525092959493602081019350359150506401000000008111156106b657600080fd5b8201836020820111156106c857600080fd5b803590602001918460018302840111640100000000831117156106ea57600080fd5b91908080601f0160208091040260200160405190810160405280939291908181526020018383808284376000920191909152509295505050813560ff1692505060208101356001600160a01b0390811691604081013582169160608201358116916080013516611710565b61075d61194f565b604080516001600160a01b039092168252519081900360200190f35b61046e61195e565b61075d61196d565b6104526004803603604081101561079f57600080fd5b506001600160a01b03813516906020013561197c565b6104a66119e9565b610452600480360360408110156107d357600080fd5b506001600160a01b038135169060200135611a85565b6104a6600480360360208110156107ff57600080fd5b5035611d68565b6104a66004803603604081101561081c57600080fd5b81019060208101813564010000000081111561083757600080fd5b82018360208201111561084957600080fd5b8035906020019184602083028401116401000000008311171561086b57600080fd5b91939092909160208101903564010000000081111561088957600080fd5b82018360208201111561089b57600080fd5b803590602001918460018302840111640100000000831117156108bd57600080fd5b509092509050611f77565b610452600480360360408110156108de57600080fd5b506001600160a01b0381351690602001356120b1565b6103b16121c7565b6104a66004803603602081101561091257600080fd5b50356001600160a01b03166121fe565b6104a6600480360360a081101561093857600080fd5b506001600160a01b038135169060208101359060ff604082013516906060810135906080013561230a565b61045261237d565b61046e6004803603602081101561098157600080fd5b50356001600160a01b031661238d565b6104a6600480360360408110156109a757600080fd5b506001600160a01b03813516906020013561239e565b61046e600480360360208110156109d357600080fd5b50356001600160a01b0316612419565b61046e612434565b6104a6612458565b6104a6600480360360e0811015610a0957600080fd5b6001600160a01b03823581169260208101359091169160408201359160608101359160808201359160a08101359181019060e0810160c0820135640100000000811115610a5557600080fd5b820183602082011115610a6757600080fd5b80359060200191846001830284011164010000000083111715610a8957600080fd5b91908080601f0160208091040260200160405190810160405280939291908181526020018383808284376000920191909152509295506124fa945050505050565b61046e60048036036020811015610ae057600080fd5b50356001600160a01b03166125ff565b6104a660048036036040811015610b0657600080fd5b506001600160a01b03813516906020013561261a565b61075d612696565b61075d6126a5565b6103b16126ca565b61075d612743565b6104a6600480360360a0811015610b5257600080fd5b6001600160a01b03823581169260208101359091169160408201359160608101359181019060a081016080820135640100000000811115610b9257600080fd5b820183602082011115610ba457600080fd5b80359060200191846001830284011164010000000083111715610bc657600080fd5b91908080601f016020809104026020016040519081016040528093929190818152602001838380828437600092019190915250929550612752945050505050565b61046e6127be565b6104a660048036036040811015610c2557600080fd5b506001600160a01b03813581169160200135166127e2565b61045260048036036040811015610c5357600080fd5b506001600160a01b0381351690602001356128fd565b61045260048036036040811015610c7f57600080fd5b506001600160a01b03813516906020013561296a565b6104a660048036036020811015610cab57600080fd5b50356001600160a01b0316612a6e565b61045260048036036020811015610cd157600080fd5b50356001600160a01b0316612b7a565b6104a660048036036020811015610cf757600080fd5b50356001600160a01b0316612b98565b6104a660048036036060811015610d1d57600080fd5b506001600160a01b03813581169160208101359091169060400135612ca4565b6104a660048036036060811015610d5357600080fd5b6001600160a01b0382351691602081013591810190606081016040820135640100000000811115610d8357600080fd5b820183602082011115610d9557600080fd5b80359060200191846001830284011164010000000083111715610db757600080fd5b91908080601f016020809104026020016040519081016040528093929190818152602001838380828437600092019190915250929550612d01945050505050565b61075d612d6b565b61075d612d7a565b6104a6600480360360e0811015610e1e57600080fd5b6001600160a01b03823581169260208101359091169160408201359160608101359160808201359160a08101359181019060e0810160c0820135640100000000811115610e6a57600080fd5b820183602082011115610e7c57600080fd5b80359060200191846001830284011164010000000083111715610e9e57600080fd5b91908080601f016020809104026020016040519081016040528093929190818152602001838380828437600092019190915250929550612d9f945050505050565b6104a6600480360360e0811015610ef557600080fd5b506001600160a01b03813581169160208101359091169060408101359060608101359060ff6080820135169060a08101359060c00135612e99565b6104a660048036036020811015610f4657600080fd5b810190602081018135640100000000811115610f6157600080fd5b820183602082011115610f7357600080fd5b80359060200191846001830284011164010000000083111715610f9557600080fd5b509092509050612f10565b61046e612fca565b61046e60048036036040811015610fbe57600080fd5b506001600160a01b0381358116916020013516612fee565b6104a66004803603610120811015610fed57600080fd5b506001600160a01b03813581169160208101359091169060408101359060608101359060808101359060a08101359060ff60c0820135169060e0810135906101000135613019565b6103b1613122565b6104526004803603604081101561105357600080fd5b506001600160a01b03813516906020013561319b565b6104a6600480360361012081101561108057600080fd5b506001600160a01b03813581169160208101359091169060408101359060608101359060808101359060a08101359060ff60c0820135169060e08101359061010001356131c6565b6104a6600480360360208110156110de57600080fd5b50356001600160a01b03166132c2565b6104a66004803603602081101561110457600080fd5b50356001600160a01b03166133ba565b6104526004803603602081101561112a57600080fd5b50356001600160a01b0316613443565b6004805460408051602060026001851615610100027fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0190941693909304601f810184900484028201840190925281815292918301828280156111de5780601f106111b3576101008083540402835291602001916111de565b820191906000526020600020905b8154815290600101906020018083116111c157829003601f168201915b505050505081565b600154600090600160a01b900460ff1615611248576040805162461bcd60e51b815260206004820152601060248201527f5061757361626c653a2070617573656400000000000000000000000000000000604482015290519081900360640190fd5b61125333848461344e565b50600192915050565b600b5490565b6002546001600160a01b031633146112ab5760405162461bcd60e51b815260040180806020018281038252602c815260200180614caa602c913960400191505060405180910390fd5b6112b48161353a565b6040516001600160a01b038216907f117e3210bb9aa7d9baff172026820255c6f6c30ba8999d1c2fd88e2848137c4e90600090a250565b600154600090600160a01b900460ff161561134d576040805162461bcd60e51b815260206004820152601060248201527f5061757361626c653a2070617573656400000000000000000000000000000000604482015290519081900360640190fd5b3361135781613545565b156113935760405162461bcd60e51b8152600401808060200182810382526025815260200180614f8a6025913960400191505060405180910390fd5b8461139d81613545565b156113d95760405162461bcd60e51b8152600401808060200182810382526025815260200180614f8a6025913960400191505060405180910390fd5b846113e381613545565b1561141f5760405162461bcd60e51b8152600401808060200182810382526025815260200180614f8a6025913960400191505060405180910390fd5b6001600160a01b0387166000908152600a602090815260408083203384529091529020548511156114815760405162461bcd60e51b8152600401808060200182810382526028815260200180614d9a6028913960400191505060405180910390fd5b61148c878787613566565b6001600160a01b0387166000908152600a602090815260408083203384529091529020546114ba90866136af565b6001600160a01b0388166000908152600a60209081526040808320338452909152902055600193505050509392505050565b6000546001600160a01b0316331461154b576040805162461bcd60e51b815260206004820181905260248201527f4f776e61626c653a2063616c6c6572206973206e6f7420746865206f776e6572604482015290519081900360640190fd5b6001600160a01b0381166115905760405162461bcd60e51b815260040180806020018281038252602a815260200180614be3602a913960400191505060405180910390fd5b600e80547fffffffffffffffffffffffff0000000000000000000000000000000000000000166001600160a01b0383169081179091556040517fe475e580d85111348e40d8ca33cfdd74c30fe1655c2d8537a13abc10065ffa5a90600090a250565b60125460ff1660011461160457600080fd5b600061160f3061370c565b9050801561162257611622308383613566565b61162b30613749565b50506012805460ff19166002179055565b6008546000906001600160a01b031633146116885760405162461bcd60e51b8152600401808060200182810382526029815260200180614c816029913960400191505060405180910390fd5b6001600160a01b0382166000818152600c60209081526040808320805460ff19169055600d909152808220829055517fe94479a9f7e1952cc78f2d6baab678adc1b772d936c6583def489e524cb666929190a2506001919050565b7f6e71edae12b1b97f4d1f60370fef10105fa2faae0126114a169c64845d6126c981565b60065460ff1681565b600854600160a01b900460ff16156117595760405162461bcd60e51b815260040180806020018281038252602a815260200180614e15602a913960400191505060405180910390fd5b6001600160a01b03841661179e5760405162461bcd60e51b815260040180806020018281038252602f815260200180614d47602f913960400191505060405180910390fd5b6001600160a01b0383166117e35760405162461bcd60e51b8152600401808060200182810382526029815260200180614bba6029913960400191505060405180910390fd5b6001600160a01b0382166118285760405162461bcd60e51b815260040180806020018281038252602e815260200180614dc2602e913960400191505060405180910390fd5b6001600160a01b03811661186d5760405162461bcd60e51b8152600401808060200182810382526028815260200180614f026028913960400191505060405180910390fd5b87516118809060049060208b0190614971565b5086516118949060059060208a0190614971565b5085516118a8906007906020890190614971565b506006805460ff191660ff8716179055600880547fffffffffffffffffffffffff00000000000000000000000000000000000000009081166001600160a01b03878116919091179092556001805482168684161790556002805490911691841691909117905561191781613754565b5050600880547fffffffffffffffffffffff00ffffffffffffffffffffffffffffffffffffffff16600160a01b179055505050505050565b6008546001600160a01b031681565b600061196861378e565b905090565b600e546001600160a01b031690565b600154600090600160a01b900460ff16156119de576040805162461bcd60e51b815260206004820152601060248201527f5061757361626c653a2070617573656400000000000000000000000000000000604482015290519081900360640190fd5b611253338484613883565b6001546001600160a01b03163314611a325760405162461bcd60e51b8152600401808060200182810382526022815260200180614eb66022913960400191505060405180910390fd5b600180547fffffffffffffffffffffff00ffffffffffffffffffffffffffffffffffffffff1690556040517f7805862f689e2f13df9f062ff482ad3ad112aca9e0847911ed832e158c525b3390600090a1565b600154600090600160a01b900460ff1615611ae7576040805162461bcd60e51b815260206004820152601060248201527f5061757361626c653a2070617573656400000000000000000000000000000000604482015290519081900360640190fd5b336000908152600c602052604090205460ff16611b355760405162461bcd60e51b8152600401808060200182810382526021815260200180614d266021913960400191505060405180910390fd5b33611b3f81613545565b15611b7b5760405162461bcd60e51b8152600401808060200182810382526025815260200180614f8a6025913960400191505060405180910390fd5b83611b8581613545565b15611bc15760405162461bcd60e51b8152600401808060200182810382526025815260200180614f8a6025913960400191505060405180910390fd5b6001600160a01b038516611c065760405162461bcd60e51b8152600401808060200182810382526023815260200180614b4f6023913960400191505060405180910390fd5b60008411611c455760405162461bcd60e51b8152600401808060200182810382526029815260200180614c326029913960400191505060405180910390fd5b336000908152600d602052604090205480851115611c945760405162461bcd60e51b815260040180806020018281038252602e815260200180614e88602e913960400191505060405180910390fd5b600b54611ca190866138c0565b600b55611cc086611cbb87611cb58361370c565b906138c0565b613921565b611cca81866136af565b336000818152600d602090815260409182902093909355805188815290516001600160a01b038a16937fab8530f87dc9b59234c4623bf917212bb2536d647574c8e7e5da92c2ede0c9f8928290030190a36040805186815290516001600160a01b038816916000917fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef9181900360200190a350600195945050505050565b600154600160a01b900460ff1615611dc7576040805162461bcd60e51b815260206004820152601060248201527f5061757361626c653a2070617573656400000000000000000000000000000000604482015290519081900360640190fd5b336000908152600c602052604090205460ff16611e155760405162461bcd60e51b8152600401808060200182810382526021815260200180614d266021913960400191505060405180910390fd5b33611e1f81613545565b15611e5b5760405162461bcd60e51b8152600401808060200182810382526025815260200180614f8a6025913960400191505060405180910390fd5b6000611e663361370c565b905060008311611ea75760405162461bcd60e51b8152600401808060200182810382526029815260200180614b266029913960400191505060405180910390fd5b82811015611ee65760405162461bcd60e51b8152600401808060200182810382526026815260200180614d006026913960400191505060405180910390fd5b600b54611ef390846136af565b600b55611f0433611cbb83866136af565b60408051848152905133917fcc16f5dbb4873280815c1ee09dbd06736cffcc184412cf7a71a0fdb75d397ca5919081900360200190a260408051848152905160009133917fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef9181900360200190a3505050565b60125460ff16600214611f8957600080fd5b611f95600583836149ef565b5060005b838110156120785760036000868684818110611fb157fe5b602090810292909201356001600160a01b03168352508101919091526040016000205460ff166120125760405162461bcd60e51b815260040180806020018281038252603d815260200180614a73603d913960400191505060405180910390fd5b61203685858381811061202157fe5b905060200201356001600160a01b0316613749565b6003600086868481811061204657fe5b602090810292909201356001600160a01b0316835250810191909152604001600020805460ff19169055600101611f99565b5061208230613749565b5050306000908152600360208190526040909120805460ff199081169091556012805490911690911790555050565b600154600090600160a01b900460ff1615612113576040805162461bcd60e51b815260206004820152601060248201527f5061757361626c653a2070617573656400000000000000000000000000000000604482015290519081900360640190fd5b6008546001600160a01b0316331461215c5760405162461bcd60e51b8152600401808060200182810382526029815260200180614c816029913960400191505060405180910390fd5b6001600160a01b0383166000818152600c60209081526040808320805460ff19166001179055600d825291829020859055815185815291517f46980fca912ef9bcdbd36877427b6b90e860769f604e89c0e67720cece530d209281900390910190a250600192915050565b60408051808201909152600181527f3200000000000000000000000000000000000000000000000000000000000000602082015290565b6000546001600160a01b0316331461225d576040805162461bcd60e51b815260206004820181905260248201527f4f776e61626c653a2063616c6c6572206973206e6f7420746865206f776e6572604482015290519081900360640190fd5b6001600160a01b0381166122a25760405162461bcd60e51b8152600401808060200182810382526028815260200180614ad36028913960400191505060405180910390fd5b600180547fffffffffffffffffffffffff0000000000000000000000000000000000000000166001600160a01b0383811691909117918290556040519116907fb80482a293ca2e013eda8683c9bd7fc8347cfdaeea5ede58cba46df502c2a60490600090a250565b600154600160a01b900460ff1615612369576040805162461bcd60e51b815260206004820152601060248201527f5061757361626c653a2070617573656400000000000000000000000000000000604482015290519081900360640190fd5b61237685858585856139e1565b5050505050565b600154600160a01b900460ff1681565b60006123988261370c565b92915050565b6123a66126a5565b6001600160a01b0316336001600160a01b03161461240b576040805162461bcd60e51b815260206004820152600c60248201527f4f4e4c595f474154455741590000000000000000000000000000000000000000604482015290519081900360640190fd5b6124158282613a21565b5050565b6001600160a01b031660009081526011602052604090205490565b7fd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de881565b6001546001600160a01b031633146124a15760405162461bcd60e51b8152600401808060200182810382526022815260200180614eb66022913960400191505060405180910390fd5b600180547fffffffffffffffffffffff00ffffffffffffffffffffffffffffffffffffffff16600160a01b1790556040517f6985a02210a168e66602d3235cb6db0e70f92b3ba4d376a33c0f3d9434bff62590600090a1565b600154600160a01b900460ff1615612559576040805162461bcd60e51b815260206004820152601060248201527f5061757361626c653a2070617573656400000000000000000000000000000000604482015290519081900360640190fd5b8661256381613545565b1561259f5760405162461bcd60e51b8152600401808060200182810382526025815260200180614f8a6025913960400191505060405180910390fd5b866125a981613545565b156125e55760405162461bcd60e51b8152600401808060200182810382526025815260200180614f8a6025913960400191505060405180910390fd5b6125f489898989898989613c43565b505050505050505050565b6001600160a01b03166000908152600d602052604090205490565b6126226126a5565b6001600160a01b0316336001600160a01b031614612687576040805162461bcd60e51b815260206004820152600c60248201527f4f4e4c595f474154455741590000000000000000000000000000000000000000604482015290519081900360640190fd5b6126918282611a85565b505050565b6000546001600160a01b031690565b7fdbf6298cab77bb44ebfd5abb25ed2538c2a55f7404c47e83e6531361fba28c245490565b6005805460408051602060026001851615610100027fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0190941693909304601f810184900484028201840190925281815292918301828280156111de5780601f106111b3576101008083540402835291602001916111de565b6001546001600160a01b031681565b600154600160a01b900460ff16156127b1576040805162461bcd60e51b815260206004820152601060248201527f5061757361626c653a2070617573656400000000000000000000000000000000604482015290519081900360640190fd5b6123768585858585613d30565b7f7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a226781565b60125460ff166003146127f457600080fd5b6001600160a01b03821661284f576040805162461bcd60e51b815260206004820152600f60248201527f494e56414c49445f474154455741590000000000000000000000000000000000604482015290519081900360640190fd5b60006128596126a5565b6001600160a01b0316146128b4576040805162461bcd60e51b815260206004820152600c60248201527f414c52454144595f494e49540000000000000000000000000000000000000000604482015290519081900360640190fd5b7fdbf6298cab77bb44ebfd5abb25ed2538c2a55f7404c47e83e6531361fba28c24919091557f54352c0d7cc5793352a36344bfdcdcf68ba6258544ce1aed71f60a74d882c19155565b600154600090600160a01b900460ff161561295f576040805162461bcd60e51b815260206004820152601060248201527f5061757361626c653a2070617573656400000000000000000000000000000000604482015290519081900360640190fd5b611253338484613fa6565b600154600090600160a01b900460ff16156129cc576040805162461bcd60e51b815260206004820152601060248201527f5061757361626c653a2070617573656400000000000000000000000000000000604482015290519081900360640190fd5b336129d681613545565b15612a125760405162461bcd60e51b8152600401808060200182810382526025815260200180614f8a6025913960400191505060405180910390fd5b83612a1c81613545565b15612a585760405162461bcd60e51b8152600401808060200182810382526025815260200180614f8a6025913960400191505060405180910390fd5b612a63338686613566565b506001949350505050565b6000546001600160a01b03163314612acd576040805162461bcd60e51b815260206004820181905260248201527f4f776e61626c653a2063616c6c6572206973206e6f7420746865206f776e6572604482015290519081900360640190fd5b6001600160a01b038116612b125760405162461bcd60e51b815260040180806020018281038252602f815260200180614d47602f913960400191505060405180910390fd5b600880547fffffffffffffffffffffffff0000000000000000000000000000000000000000166001600160a01b0383811691909117918290556040519116907fdb66dfa9c6b8f5226fe9aac7e51897ae8ee94ac31dc70bb6c9900b2574b707e690600090a250565b6001600160a01b03166000908152600c602052604090205460ff1690565b6000546001600160a01b03163314612bf7576040805162461bcd60e51b815260206004820181905260248201527f4f776e61626c653a2063616c6c6572206973206e6f7420746865206f776e6572604482015290519081900360640190fd5b6001600160a01b038116612c3c5760405162461bcd60e51b8152600401808060200182810382526032815260200180614f586032913960400191505060405180910390fd5b600280547fffffffffffffffffffffffff0000000000000000000000000000000000000000166001600160a01b0383811691909117918290556040519116907fc67398012c111ce95ecb7429b933096c977380ee6c421175a71a4a4c6c88c06e90600090a250565b600e546001600160a01b03163314612ced5760405162461bcd60e51b8152600401808060200182810382526024815260200180614d766024913960400191505060405180910390fd5b6126916001600160a01b0384168383613ff5565b600154600160a01b900460ff1615612d60576040805162461bcd60e51b815260206004820152601060248201527f5061757361626c653a2070617573656400000000000000000000000000000000604482015290519081900360640190fd5b612691838383614075565b6002546001600160a01b031681565b7f54352c0d7cc5793352a36344bfdcdcf68ba6258544ce1aed71f60a74d882c1915490565b600154600160a01b900460ff1615612dfe576040805162461bcd60e51b815260206004820152601060248201527f5061757361626c653a2070617573656400000000000000000000000000000000604482015290519081900360640190fd5b86612e0881613545565b15612e445760405162461bcd60e51b8152600401808060200182810382526025815260200180614f8a6025913960400191505060405180910390fd5b86612e4e81613545565b15612e8a5760405162461bcd60e51b8152600401808060200182810382526025815260200180614f8a6025913960400191505060405180910390fd5b6125f489898989898989614147565b600154600160a01b900460ff1615612ef8576040805162461bcd60e51b815260206004820152601060248201527f5061757361626c653a2070617573656400000000000000000000000000000000604482015290519081900360640190fd5b612f07878787878787876141d8565b50505050505050565b600854600160a01b900460ff168015612f2c575060125460ff16155b612f3557600080fd5b612f41600483836149ef565b50612fb682828080601f0160208091040260200160405190810160405280939291908181526020018383808284376000920191909152505060408051808201909152600181527f32000000000000000000000000000000000000000000000000000000000000006020820152915061421a9050565b600f5550506012805460ff19166001179055565b7f158b0a9edf7a828aad02f63cd515c68ef2f50ba807396f6d12842833a159742981565b6001600160a01b039182166000908152600a6020908152604080832093909416825291909152205490565b600154600160a01b900460ff1615613078576040805162461bcd60e51b815260206004820152601060248201527f5061757361626c653a2070617573656400000000000000000000000000000000604482015290519081900360640190fd5b8861308281613545565b156130be5760405162461bcd60e51b8152600401808060200182810382526025815260200180614f8a6025913960400191505060405180910390fd5b886130c881613545565b156131045760405162461bcd60e51b8152600401808060200182810382526025815260200180614f8a6025913960400191505060405180910390fd5b6131158b8b8b8b8b8b8b8b8b614230565b5050505050505050505050565b6007805460408051602060026001851615610100027fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0190941693909304601f810184900484028201840190925281815292918301828280156111de5780601f106111b3576101008083540402835291602001916111de565b6001600160a01b03919091166000908152601060209081526040808320938352929052205460ff1690565b600154600160a01b900460ff1615613225576040805162461bcd60e51b815260206004820152601060248201527f5061757361626c653a2070617573656400000000000000000000000000000000604482015290519081900360640190fd5b8861322f81613545565b1561326b5760405162461bcd60e51b8152600401808060200182810382526025815260200180614f8a6025913960400191505060405180910390fd5b8861327581613545565b156132b15760405162461bcd60e51b8152600401808060200182810382526025815260200180614f8a6025913960400191505060405180910390fd5b6131158b8b8b8b8b8b8b8b8b614274565b6000546001600160a01b03163314613321576040805162461bcd60e51b815260206004820181905260248201527f4f776e61626c653a2063616c6c6572206973206e6f7420746865206f776e6572604482015290519081900360640190fd5b6001600160a01b0381166133665760405162461bcd60e51b8152600401808060200182810382526026815260200180614b726026913960400191505060405180910390fd5b600054604080516001600160a01b039283168152918316602083015280517f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e09281900390910190a16133b781613754565b50565b6002546001600160a01b031633146134035760405162461bcd60e51b815260040180806020018281038252602c815260200180614caa602c913960400191505060405180910390fd5b61340c81613749565b6040516001600160a01b038216907fffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b85590600090a250565b600061239882613545565b6001600160a01b0383166134935760405162461bcd60e51b8152600401808060200182810382526024815260200180614e646024913960400191505060405180910390fd5b6001600160a01b0382166134d85760405162461bcd60e51b8152600401808060200182810382526022815260200180614b986022913960400191505060405180910390fd5b6001600160a01b038084166000818152600a6020908152604080832094871680845294825291829020859055815185815291517f8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b9259281900390910190a3505050565b6133b78160006142b8565b6001600160a01b031660009081526009602052604090205460ff1c60011490565b6001600160a01b0383166135ab5760405162461bcd60e51b8152600401808060200182810382526025815260200180614e3f6025913960400191505060405180910390fd5b6001600160a01b0382166135f05760405162461bcd60e51b8152600401808060200182810382526023815260200180614ab06023913960400191505060405180910390fd5b6135f98361370c565b8111156136375760405162461bcd60e51b8152600401808060200182810382526026815260200180614c5b6026913960400191505060405180910390fd5b61364e83611cbb836136488761370c565b906136af565b61365f82611cbb83611cb58661370c565b816001600160a01b0316836001600160a01b03167fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef836040518082815260200191505060405180910390a3505050565b600082821115613706576040805162461bcd60e51b815260206004820152601e60248201527f536166654d6174683a207375627472616374696f6e206f766572666c6f770000604482015290519081900360640190fd5b50900390565b6001600160a01b03166000908152600960205260409020547f7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff1690565b6133b78160016142b8565b600080547fffffffffffffffffffffffff0000000000000000000000000000000000000000166001600160a01b0392909216919091179055565b6004805460408051602060026001851615610100027fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0190941693909304601f8101849004840282018401909252818152600093611968939192909183018282801561383b5780601f106138105761010080835404028352916020019161383b565b820191906000526020600020905b81548152906001019060200180831161381e57829003601f168201915b50505050506040518060400160405280600181526020017f320000000000000000000000000000000000000000000000000000000000000081525061387e614327565b61432b565b6001600160a01b038084166000908152600a602090815260408083209386168352929052205461269190849084906138bb90856138c0565b61344e565b60008282018381101561391a576040805162461bcd60e51b815260206004820152601b60248201527f536166654d6174683a206164646974696f6e206f766572666c6f770000000000604482015290519081900360640190fd5b9392505050565b7f7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8111156139805760405162461bcd60e51b815260040180806020018281038252602a815260200180614cd6602a913960400191505060405180910390fd5b61398982613545565b156139c55760405162461bcd60e51b8152600401808060200182810382526025815260200180614c0d6025913960400191505060405180910390fd5b6001600160a01b03909116600090815260096020526040902055565b6123768585848487604051602001808481526020018381526020018260ff1660f81b81526001019350505050604051602081830303815290604052614075565b600154600160a01b900460ff1615613a80576040805162461bcd60e51b815260206004820152601060248201527f5061757361626c653a2070617573656400000000000000000000000000000000604482015290519081900360640190fd5b336000908152600c602052604090205460ff16613ace5760405162461bcd60e51b8152600401808060200182810382526021815260200180614d266021913960400191505060405180910390fd5b81613ad881613545565b15613b145760405162461bcd60e51b8152600401808060200182810382526025815260200180614f8a6025913960400191505060405180910390fd5b6000613b1f8461370c565b905060008311613b605760405162461bcd60e51b8152600401808060200182810382526029815260200180614b266029913960400191505060405180910390fd5b82811015613b9f5760405162461bcd60e51b8152600401808060200182810382526026815260200180614d006026913960400191505060405180910390fd5b600b54613bac90846136af565b600b55613bbd84611cbb83866136af565b6040805184815290516001600160a01b038616917fcc16f5dbb4873280815c1ee09dbd06736cffcc184412cf7a71a0fdb75d397ca5919081900360200190a26040805184815290516000916001600160a01b038716917fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef9181900360200190a350505050565b6001600160a01b0386163314613c8a5760405162461bcd60e51b8152600401808060200182810382526025815260200180614df06025913960400191505060405180910390fd5b613c968783868661439f565b604080517fd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de86020808301919091526001600160a01b03808b1683850152891660608301526080820188905260a0820187905260c0820186905260e0808301869052835180840390910181526101009092019092528051910120613d1b9088908361442b565b613d258783614582565b612f07878787613566565b7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff821480613d5e5750428210155b613daf576040805162461bcd60e51b815260206004820152601e60248201527f46696174546f6b656e56323a207065726d697420697320657870697265640000604482015290519081900360640190fd5b6000613e4a613dbc61378e565b6001600160a01b0380891660008181526011602090815260409182902080546001810190915582517f6e71edae12b1b97f4d1f60370fef10105fa2faae0126114a169c64845d6126c98184015280840194909452938b166060840152608083018a905260a083019390935260c08083018990528151808403909101815260e0909201905280519101206145dc565b905073__$715109b5d747ea58b675c6ea3f0dba8c60$__636ccea6528783856040518463ffffffff1660e01b815260040180846001600160a01b0316815260200183815260200180602001828103825283818151815260200191508051906020019080838360005b83811015613eca578181015183820152602001613eb2565b50505050905090810190601f168015613ef75780820380516001836020036101000a031916815260200191505b5094505050505060206040518083038186803b158015613f1657600080fd5b505af4158015613f2a573d6000803e3d6000fd5b505050506040513d6020811015613f4057600080fd5b5051613f93576040805162461bcd60e51b815260206004820152601a60248201527f454950323631323a20696e76616c6964207369676e6174757265000000000000604482015290519081900360640190fd5b613f9e86868661344e565b505050505050565b61269183836138bb84604051806060016040528060258152602001614fd4602591396001600160a01b03808a166000908152600a60209081526040808320938c16835292905220549190614616565b604080516001600160a01b038416602482015260448082018490528251808303909101815260649091019091526020810180517bffffffffffffffffffffffffffffffffffffffffffffffffffffffff167fa9059cbb000000000000000000000000000000000000000000000000000000001790526126919084906146ad565b61407f838361475e565b6140ec837f158b0a9edf7a828aad02f63cd515c68ef2f50ba807396f6d12842833a159742960001b858560405160200180848152602001836001600160a01b031681526020018281526020019350505050604051602081830303815290604052805190602001208361442b565b6001600160a01b0383166000818152601060209081526040808320868452909152808220805460ff19166001179055518492917f1cdd46ff242716cdaa72d159d339a485b3438398348d68f09d7c8c0a59353d8191a3505050565b6141538783868661439f565b604080517f7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a22676020808301919091526001600160a01b03808b1683850152891660608301526080820188905260a0820187905260c0820186905260e0808301869052835180840390910181526101009092019092528051910120613d1b9088908361442b565b612f0787878787868689604051602001808481526020018381526020018260ff1660f81b81526001019350505050604051602081830303815290604052613d30565b60004661422884848361432b565b949350505050565b6125f489898989898988888b604051602001808481526020018381526020018260ff1660f81b81526001019350505050604051602081830303815290604052614147565b6125f489898989898988888b604051602001808481526020018381526020018260ff1660f81b81526001019350505050604051602081830303815290604052613c43565b806142cb576142c68261370c565b614307565b6001600160a01b0382166000908152600960205260409020547f8000000000000000000000000000000000000000000000000000000000000000175b6001600160a01b0390921660009081526009602052604090209190915550565b4690565b8251602093840120825192840192909220604080517f8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f8187015280820194909452606084019190915260808301919091523060a0808401919091528151808403909101815260c09092019052805191012090565b8142116143dd5760405162461bcd60e51b815260040180806020018281038252602b815260200180614afb602b913960400191505060405180910390fd5b80421061441b5760405162461bcd60e51b8152600401808060200182810382526025815260200180614faf6025913960400191505060405180910390fd5b614425848461475e565b50505050565b73__$715109b5d747ea58b675c6ea3f0dba8c60$__636ccea6528461445761445161378e565b866145dc565b846040518463ffffffff1660e01b815260040180846001600160a01b0316815260200183815260200180602001828103825283818151815260200191508051906020019080838360005b838110156144b95781810151838201526020016144a1565b50505050905090810190601f1680156144e65780820380516001836020036101000a031916815260200191505b5094505050505060206040518083038186803b15801561450557600080fd5b505af4158015614519573d6000803e3d6000fd5b505050506040513d602081101561452f57600080fd5b5051612691576040805162461bcd60e51b815260206004820152601e60248201527f46696174546f6b656e56323a20696e76616c6964207369676e61747572650000604482015290519081900360640190fd5b6001600160a01b0382166000818152601060209081526040808320858452909152808220805460ff19166001179055518392917f98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a591a35050565b6040517f19010000000000000000000000000000000000000000000000000000000000008152600281019290925260228201526042902090565b600081848411156146a55760405162461bcd60e51b81526004018080602001828103825283818151815260200191508051906020019080838360005b8381101561466a578181015183820152602001614652565b50505050905090810190601f1680156146975780820380516001836020036101000a031916815260200191505b509250505060405180910390fd5b505050900390565b6060614702826040518060400160405280602081526020017f5361666545524332303a206c6f772d6c6576656c2063616c6c206661696c6564815250856001600160a01b03166147c19092919063ffffffff16565b8051909150156126915780806020019051602081101561472157600080fd5b50516126915760405162461bcd60e51b815260040180806020018281038252602a815260200180614ed8602a913960400191505060405180910390fd5b6001600160a01b038216600090815260106020908152604080832084845290915290205460ff16156124155760405162461bcd60e51b815260040180806020018281038252602e815260200180614f2a602e913960400191505060405180910390fd5b60606142288484600085856147d585614905565b614826576040805162461bcd60e51b815260206004820152601d60248201527f416464726573733a2063616c6c20746f206e6f6e2d636f6e7472616374000000604482015290519081900360640190fd5b60006060866001600160a01b031685876040518082805190602001908083835b6020831061488357805182527fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe09092019160209182019101614846565b6001836020036101000a03801982511681845116808217855250505050505090500191505060006040518083038185875af1925050503d80600081146148e5576040519150601f19603f3d011682016040523d82523d6000602084013e6148ea565b606091505b50915091506148fa82828661490b565b979650505050505050565b3b151590565b6060831561491a57508161391a565b82511561492a5782518084602001fd5b60405162461bcd60e51b815260206004820181815284516024840152845185939192839260440191908501908083836000831561466a578181015183820152602001614652565b828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f106149b257805160ff19168380011785556149df565b828001600101855582156149df579182015b828111156149df5782518255916020019190600101906149c4565b506149eb929150614a5d565b5090565b828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f10614a305782800160ff198235161785556149df565b828001600101855582156149df579182015b828111156149df578235825591602001919060010190614a42565b5b808211156149eb5760008155600101614a5e56fe46696174546f6b656e56325f323a20426c61636b6c697374696e672070726576696f75736c7920756e626c61636b6c6973746564206163636f756e742145524332303a207472616e7366657220746f20746865207a65726f20616464726573735061757361626c653a206e65772070617573657220697320746865207a65726f206164647265737346696174546f6b656e56323a20617574686f72697a6174696f6e206973206e6f74207965742076616c696446696174546f6b656e3a206275726e20616d6f756e74206e6f742067726561746572207468616e203046696174546f6b656e3a206d696e7420746f20746865207a65726f20616464726573734f776e61626c653a206e6577206f776e657220697320746865207a65726f206164647265737345524332303a20617070726f766520746f20746865207a65726f206164647265737346696174546f6b656e3a206e65772070617573657220697320746865207a65726f2061646472657373526573637561626c653a206e6577207265736375657220697320746865207a65726f206164647265737346696174546f6b656e56325f323a204163636f756e7420697320626c61636b6c697374656446696174546f6b656e3a206d696e7420616d6f756e74206e6f742067726561746572207468616e203045524332303a207472616e7366657220616d6f756e7420657863656564732062616c616e636546696174546f6b656e3a2063616c6c6572206973206e6f7420746865206d61737465724d696e746572426c61636b6c69737461626c653a2063616c6c6572206973206e6f742074686520626c61636b6c697374657246696174546f6b656e56325f323a2042616c616e636520657863656564732028325e323535202d20312946696174546f6b656e3a206275726e20616d6f756e7420657863656564732062616c616e636546696174546f6b656e3a2063616c6c6572206973206e6f742061206d696e74657246696174546f6b656e3a206e6577206d61737465724d696e74657220697320746865207a65726f2061646472657373526573637561626c653a2063616c6c6572206973206e6f7420746865207265736375657245524332303a207472616e7366657220616d6f756e74206578636565647320616c6c6f77616e636546696174546f6b656e3a206e657720626c61636b6c697374657220697320746865207a65726f206164647265737346696174546f6b656e56323a2063616c6c6572206d7573742062652074686520706179656546696174546f6b656e3a20636f6e747261637420697320616c726561647920696e697469616c697a656445524332303a207472616e736665722066726f6d20746865207a65726f206164647265737345524332303a20617070726f76652066726f6d20746865207a65726f206164647265737346696174546f6b656e3a206d696e7420616d6f756e742065786365656473206d696e746572416c6c6f77616e63655061757361626c653a2063616c6c6572206973206e6f7420746865207061757365725361666545524332303a204552433230206f7065726174696f6e20646964206e6f74207375636365656446696174546f6b656e3a206e6577206f776e657220697320746865207a65726f206164647265737346696174546f6b656e56323a20617574686f72697a6174696f6e2069732075736564206f722063616e63656c6564426c61636b6c69737461626c653a206e657720626c61636b6c697374657220697320746865207a65726f2061646472657373426c61636b6c69737461626c653a206163636f756e7420697320626c61636b6c697374656446696174546f6b656e56323a20617574686f72697a6174696f6e206973206578706972656445524332303a2064656372656173656420616c6c6f77616e63652062656c6f77207a65726fa2646970667358221220615e051a229e77d8da0781c2c1926a3017e6914f059e90a4aa05450168f36bdc64736f6c634300060c0033'
  const placeholder = '__$715109b5d747ea58b675c6ea3f0dba8c60$__'

  const libAddressStripped = sigCheckerLib.address.replace(/^0x/, '')
  const bridgedUsdcLogicBytecode = bytecodeWithPlaceholder
    .split(placeholder)
    .join(libAddressStripped)

  // deploy bridged usdc logic
  const bridgedUsdcLogicFactory = new ethers.ContractFactory(
    [],
    bridgedUsdcLogicBytecode,
    deployer
  )
  const bridgedUsdcLogic = await bridgedUsdcLogicFactory.deploy()

  return bridgedUsdcLogic
}
