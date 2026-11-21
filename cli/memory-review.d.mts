export function inert(text: string): string;
export function formatReview(answer: { state: string; items?: Record<string, unknown>[] }, options?: { dashboard?: string }): string[];
export function memoryReviewCommand(options: { sidecarUrl: string; cwd?: string; client?: string; fetchImpl?: typeof fetch; print?: (line: string) => void }): Promise<void>;
