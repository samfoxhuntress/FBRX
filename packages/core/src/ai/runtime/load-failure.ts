/** Why llama.cpp could not load a model, read from its output, in words a person can act on. */
export interface LoadFailure {
  kind: 'gpu-memory' | 'memory' | 'damaged' | 'unsupported' | 'other';
  /** One sentence: what happened and what to do. */
  message: string;
  /** The line from the runtime that says so. */
  detail: string | null;
}

const GPU_MEMORY = [
  /ErrorOutOfDeviceMemory/i,
  /failed to allocate (?:Vulkan|CUDA|ROCm|HIP|Metal|SYCL|OpenCL)\d*[^\n]*buffer/i,
  /(?:vulkan|vk|cuda|ggml_cuda|metal|hip|sycl)[^\n]*(?:out of memory|allocation[^\n]*failed|failed to allocate)/i,
  /cudaMalloc[^\n]*failed/i,
  /Device memory allocation[^\n]*failed/i,
  /unable to allocate (?:Vulkan|CUDA|ROCm|Metal)\d*[^\n]*buffer/i,
];
const MEMORY = [/failed to allocate CPU buffer/i, /unable to allocate CPU[^\n]*buffer/i, /std::bad_alloc/, /not enough (?:memory|space)/i, /mmap failed/i, /failed to mmap/i, /cannot allocate memory/i];
const DAMAGED = [
  /not within the file bounds/i,
  /corrupted or incomplete/i,
  /invalid magic/i,
  /failed to read magic/i,
  /unexpectedly reached end of file/i,
  /tensor '[^']+' has wrong (?:size|shape)/i,
  /failed to read (?:key|tensor info|header)/i,
  /gguf_init_from_file[^\n]*failed/i,
];

/**
 * Reads the runtime's last lines after a failed start. The interesting line ("error loading model: …") is usually a
 * few lines above "exiting due to model loading error", so all of them are searched, newest last.
 */
export function explainLoadFailure(lines: string[], modelName: string, onGpu: boolean): LoadFailure {
  const find = (res: RegExp[]) => {
    for (let i = lines.length - 1; i >= 0; i--) if (res.some((re) => re.test(lines[i]))) return lines[i].trim();
    return null;
  };
  const errorLine = find([/error loading model/i, /failed to load model/i]);
  let hit = onGpu ? find(GPU_MEMORY) : null;
  if (hit) return { kind: 'gpu-memory', message: `${modelName} does not fit in the graphics card's memory.`, detail: hit };
  hit = find(MEMORY);
  if (hit) return { kind: 'memory', message: `There is not enough free memory to load ${modelName}. Close some apps, or pick a smaller model.`, detail: hit };
  hit = find(DAMAGED);
  if (hit) return { kind: 'damaged', message: `The ${modelName} file is incomplete or damaged. Download it again (AI models → Download again).`, detail: hit };
  const arch = lines.map((l) => /unknown model architecture: '([^']+)'/i.exec(l)?.[1]).find(Boolean);
  if (arch) return { kind: 'unsupported', message: `This copy of the runtime is too old for ${modelName} (${arch} models). Update the runtime (AI models → Update the runtime).`, detail: `unknown model architecture: '${arch}'` };
  const reason = errorLine?.replace(/^.*?error loading model:\s*/i, '').trim();
  return { kind: 'other', message: reason && reason !== errorLine ? `${modelName} could not be loaded: ${reason}` : `${modelName} could not be loaded.`, detail: errorLine ?? lines.at(-1)?.trim() ?? null };
}
