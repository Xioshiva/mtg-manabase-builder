import { buildModel, runAnalysis } from './lib/analysis.js';
import { getFormat } from './lib/formats.js';

self.onmessage = (e) => {
  const { parsed, cards, formatId, mode, candidateCards, games, play, landCount, optimize, keepUtility } = e.data;
  try {
    const format = getFormat(formatId);
    const built = buildModel(parsed, new Map(cards), format);
    const result = runAnalysis({
      model: built.model, mode, candidateCards, games, play, landCount, optimize, keepUtility,
      onProgress: (p) => self.postMessage({ type: 'progress', ...p }),
    });
    self.postMessage({ type: 'done', result: { ...result, unknown: built.unknown, illegal: built.illegal, warnings: built.warnings } });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message, stack: err.stack });
  }
};
