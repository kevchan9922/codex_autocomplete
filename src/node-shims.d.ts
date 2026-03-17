declare module 'fs/promises' {
  export function readFile(path: string, encoding: 'utf8'): Promise<string>;
  export function writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
  export function appendFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
  export function mkdir(
    path: string,
    options?: {
      recursive?: boolean;
    },
  ): Promise<void>;
}

declare module 'path' {
  export function join(...paths: string[]): string;
  export function isAbsolute(path: string): boolean;
}

declare module 'node:http' {
  export function createServer(...args: any[]): any;
}

declare const Buffer: {
  from(input: string | ArrayBuffer | Uint8Array, encoding?: string): {
    toString(encoding?: string): string;
  };
};
