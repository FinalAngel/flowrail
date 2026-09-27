// Worker entry for audit-worker.js: one audit, answered to the parent thread.
import { parentPort, workerData } from 'node:worker_threads';
import { auditSummary } from 'flowrail/api';

parentPort.postMessage(auditSummary(workerData.root, { days: workerData.days, env: workerData.env }));
