/** Product identity. Changing APP_ID breaks upgrade paths for installed clients. */
export const PRODUCT_NAME = 'FBRX OS';
export const PRODUCT_FULL_NAME = 'FBRX OS — Fabrics Operating System';
export const APP_ID = 'com.fbrx.os';

/** Wire protocol between desktop clients and the control plane. Bump on breaking changes. */
export const PROTOCOL_VERSION = 1;

/** Snapshot (backup) container format version. */
export const SNAPSHOT_FORMAT_VERSION = 1;

export const DEFAULT_LOCAL_API_PORT = 47821;
export const DEFAULT_RUNTIME_PORT = 47822;
export const DEFAULT_CONTROL_PLANE_PORT = 8787;
/** License key file picked up from the data folder on start (written by the setup wizard or IT tooling). */
export const LICENSE_FILE_NAME = 'fbrx-license.key';

export const UPDATE_CHANNELS = ['stable', 'beta', 'dev'] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

export const PLATFORMS = ['darwin', 'win32', 'linux'] as const;
export type Platform = (typeof PLATFORMS)[number];
