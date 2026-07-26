import type { DatabaseSync } from "node:sqlite";
import { up as initialSchema } from "./001-initial-schema.ts";

export interface Migration {
  version: number;
  name: string;
  up(db: DatabaseSync): void;
}

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "initial-schema", up: initialSchema },
];
