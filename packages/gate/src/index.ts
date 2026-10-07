/**
 * FBRX Gate, the parts that run anywhere (the console uses them too): the configuration, its checks, what it turns
 * into, and differences. The engine and the Linux applier are in @fbrx/gate/node.
 */
export * from './model';
export * from './validate';
export * from './diff';
export * from './render/index';
export { WG_IFACE, NFT_TABLE, gateInterfaces, zoneInterfaces } from './render/nftables';
export { peerConfig } from './render/wireguard';
export { DEFAULT_PATHS, type GatePaths } from './render/paths';
export { IFB } from './render/qos';
export * from './types';
