export interface RecordInfo {
  pid: number;
  id: string;
  token: string;
  port?: number;
  root?: string;
  directory?: string;
}
export function acquireLease(
  directory: string,
  name: string,
  extra?: object,
): Promise<{
  record: RecordInfo;
  update(extra: object): Promise<void>;
  release(): Promise<void>;
}>;
export function readRecord(
  directory: string,
  name: string,
): Promise<RecordInfo | null>;
export function control(
  record: RecordInfo | null,
  action?: string,
): Promise<RecordInfo | null>;
export function alive(pid: number): boolean;
export function leasePort(directory: string, name: string): Promise<number>;
export function delay(ms: number): Promise<void>;
export function openBrowser(url: string): Promise<void>;
