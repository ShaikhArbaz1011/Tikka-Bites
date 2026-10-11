// Types for fakeAppsScript.mjs (the tests only need these).
export interface FakeSheet {
  name: string;
  rows: number;
  cols: number;
  hidden: Set<number>;
  protected: boolean;
  getName(): string;
  getLastRow(): number;
  dump(): unknown[][];
  handEdit(fn: (sh: FakeSheet) => void): void;
  getRange(row: number, col: number, numRows?: number, numCols?: number): {
    getValues(): unknown[][];
    setValues(v: unknown[][]): unknown;
    clearContent(): unknown;
  };
  insertColumnsAfter(after: number, n: number): unknown;
  deleteColumns(pos: number, n: number): void;
  deleteRows(pos: number, n: number): void;
}

export interface FakeSpreadsheet {
  id: string;
  name: string;
  trashed: boolean;
  parents: string[];
  sheets: FakeSheet[];
  getId(): string;
  getSheets(): FakeSheet[];
  getSheetByName(name: string): FakeSheet | null;
  deleteSheet(sh: FakeSheet): void;
}

export interface Runtime {
  clock: number | null;
  files: Map<string, FakeSpreadsheet | { kind: 'folder'; id: string; name: string; parents: string[] }>;
  props: Map<string, string>;
  cache: Map<string, { v: string; until: number }>;
  triggers: { fn: string; hour?: number; minute?: number; tz?: string }[];
  lockHeld: boolean;
  lockBusy: boolean;
  dirty: boolean;
  writes: number;
  failAfter: number;
  failFiles: Set<string>;
  formulaWrites: number;
  propReads: number;
  violations: string[];
  evictCache: boolean;
  logs: string[];
}

export interface Reply<T = any> {
  ok: boolean;
  data: T;
  error?: { kind: string; message: string };
}

export interface FakeAppsScript {
  rt: Runtime;
  control: FakeSpreadsheet;
  exec(fn: string, ...args: unknown[]): any;
  post<T = any>(body: unknown): Reply<T>;
  useUi(answers?: (string | null)[]): string[];
  sheet(id: string): FakeSpreadsheet;
  mainId(): string;
  backupId(): string;
  main(): FakeSpreadsheet;
  backup(): FakeSpreadsheet;
  rows(ss: FakeSpreadsheet, tab: string): unknown[][];
  records<T = any>(ss: FakeSpreadsheet, tab: string): T[];
  snapshot(ss: FakeSpreadsheet): Record<string, unknown[][]>;
}

export function createRuntime(opts?: { now?: number }): FakeAppsScript;
