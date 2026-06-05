/// <reference types="bun-types" />

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      BUN_VERSION?: string;
    }
  }
}

export {};
