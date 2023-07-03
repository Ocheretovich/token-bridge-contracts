// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import { L1GatewayRouter } from "./gateway/L1GatewayRouter.sol";
import { L1ERC20Gateway } from "./gateway/L1ERC20Gateway.sol";
import { L1CustomGateway } from "./gateway/L1CustomGateway.sol";
import { ProxyAdmin } from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import { TransparentUpgradeableProxy } from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { IInbox } from "@arbitrum/nitro-contracts/src/bridge/IInbox.sol";

contract L1AtomicTokenBridgeCreator is Ownable {
    event OrbitTokenBridgeCreated(
        address router,
        address standardGateway,
        address customGateway,
        address proxyAdmin
    );
    event OrbitTokenBridgeTemplatesUpdated();

    L1GatewayRouter public routerTemplate;
    L1ERC20Gateway public standardGatewayTemplate;
    L1CustomGateway public customGatewayTemplate;

    function setTemplates(
        L1GatewayRouter _router,
        L1ERC20Gateway _standardGateway,
        L1CustomGateway _customGateway
    ) external onlyOwner {
        routerTemplate = _router;
        standardGatewayTemplate = _standardGateway;
        customGatewayTemplate = _customGateway;
        emit OrbitTokenBridgeTemplatesUpdated();
    }

    function createTokenBridge(
        address l2FactoryAddressOnL1,
        address inbox,
        uint256 maxSubmissionCost,
        uint256 maxGas,
        uint256 gasPriceBid
    ) external payable {
        address proxyAdmin = address(new ProxyAdmin());

        L1GatewayRouter router = L1GatewayRouter(
            address(new TransparentUpgradeableProxy(address(routerTemplate), proxyAdmin, bytes("")))
        );
        L1ERC20Gateway standardGateway = L1ERC20Gateway(
            address(
                new TransparentUpgradeableProxy(
                    address(standardGatewayTemplate),
                    proxyAdmin,
                    bytes("")
                )
            )
        );
        L1CustomGateway customGateway = L1CustomGateway(
            address(
                new TransparentUpgradeableProxy(
                    address(customGatewayTemplate),
                    proxyAdmin,
                    bytes("")
                )
            )
        );

        emit OrbitTokenBridgeCreated(
            address(router),
            address(standardGateway),
            address(customGateway),
            proxyAdmin
        );

        _deployL2Factory(l2FactoryAddressOnL1, inbox, maxSubmissionCost, maxGas, gasPriceBid);

        // _deployL2TokenBridgeViaRetryable(
        //     l2TokenBridgeFactoryViaRetryables,
        //     inbox,
        //     address(router),
        //     address(standardGateway),
        //     address(customGateway),
        //     maxSubmissionCost,
        //     maxGas,
        //     gasPriceBid
        // );

        //// init contracts
        // {
        //     /// dependencies - l2Router, l2StandardGateway, l2CustomGateway, cloneableProxyHash, l2BeaconProxyFactory, owner, inbox
        //     router.initialize(address(1), address(standardGateway), address(0), address(1), inbox);
        //     standardGateway.initialize(address(1), address(router), inbox, "abc", address(1));
        //     customGateway.initialize(address(1), address(router), inbox, address(1));
        // }
    }

    function _deployL2Factory(
        address l2FactoryAddressOnL1,
        address inbox,
        uint256 maxSubmissionCost,
        uint256 maxGas,
        uint256 gasPriceBid
    ) internal returns (uint256) {
        // encode L2 factory bytecode
        bytes memory deploymentData = creationCodeFor(l2FactoryAddressOnL1.code);

        uint256 ticketID = IInbox(inbox).createRetryableTicket{ value: msg.value }(
            address(0),
            0,
            maxSubmissionCost,
            msg.sender,
            msg.sender,
            maxGas,
            gasPriceBid,
            deploymentData
        );

        return ticketID;
    }

    // function _deployL2TokenBridgeViaRetryable(
    //     address l2TokenBridgeFactoryViaRetryables,
    //     address inbox,
    //     address l1Router,
    //     address l1StandardGateway,
    //     address l1CustomGateway,
    //     uint256 maxSubmissionCost,
    //     uint256 maxGas,
    //     uint256 gasPriceBid
    // ) internal returns (uint256) {
    //     // encode L2 factory bytecode + encoded constructor args
    //     bytes memory bytecode = l2TokenBridgeFactoryViaRetryables.code;
    //     bytes memory args = abi.encodePacked(l1Router, l1StandardGateway, l1CustomGateway);
    //     bytes memory deploymentData = abi.encodePacked(bytecode, args);

    //     uint256 ticketID = IInbox(inbox).createRetryableTicket{ value: msg.value }(
    //         address(0),
    //         0,
    //         maxSubmissionCost,
    //         msg.sender,
    //         msg.sender,
    //         maxGas,
    //         gasPriceBid,
    //         deploymentData
    //     );

    //     return ticketID;
    // }

    /**
     * @notice Generate a creation code that results on a contract with `_code` as bytecode
     * @param _code The returning value of the resulting `creationCode`
     * @return creationCode (constructor) for new contract
     */
    function creationCodeFor(bytes memory _code) internal pure returns (bytes memory) {
        /*
            0x00    0x63         0x63XXXXXX  PUSH4 _code.length  size
            0x01    0x80         0x80        DUP1                size size
            0x02    0x60         0x600e      PUSH1 14            14 size size
            0x03    0x60         0x6000      PUSH1 00            0 14 size size
            0x04    0x39         0x39        CODECOPY            size
            0x05    0x60         0x6000      PUSH1 00            0 size
            0x06    0xf3         0xf3        RETURN
            <CODE>
        */

        return
            abi.encodePacked(hex"63", uint32(_code.length), hex"80_60_0E_60_00_39_60_00_F3", _code);
    }
}
