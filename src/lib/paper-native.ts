import { invoke } from '@tauri-apps/api/core';
import { fetch } from '@tauri-apps/plugin-http';
import { PaperClient } from './paper-client';
export const createPaperClient = () => new PaperClient(fetch, { read: () => invoke<string>('read_paper_auth'), write: value => invoke('write_paper_auth', { value }) });
