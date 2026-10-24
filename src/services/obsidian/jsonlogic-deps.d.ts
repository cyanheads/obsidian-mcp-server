/**
 * @fileoverview Type declarations for the two operator libraries the Local REST
 * API plugin evaluates JSONLogic with, covering only the surface this server
 * calls. Neither package ships its own types.
 * @module services/obsidian/jsonlogic-deps
 */

declare module 'json-logic-js' {
  type Operation = (this: unknown, ...args: unknown[]) => unknown;

  interface JsonLogic {
    add_operation(name: string, code: Operation): void;
    apply(logic: unknown, data?: unknown): unknown;
  }

  const jsonLogic: JsonLogic;
  export = jsonLogic;
}

declare module 'glob-to-regexp' {
  function globToRegExp(glob: string): RegExp;
  export = globToRegExp;
}
