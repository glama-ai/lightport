/**
 * Framework-agnostic request context used throughout the gateway.
 * Replaces Hono's `Context` type so handlers and providers
 * are decoupled from any specific HTTP framework.
 */
export interface GatewayContext {
  req: {
    url: string;
    method: string;
    param: () => Record<string, string>;
  };
  get: (key: string) => any;
  set: (key: string, value: any) => void;
}
