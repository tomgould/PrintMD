/**
 * A small concurrency limiter: maxActive jobs at once, up to maxQueue waiting,
 * and anything beyond that refused at once with 429 and Retry-After.
 */
import {ApiError} from './errors.mjs';

export const RETRY_AFTER_SECONDS = 5;

export class Limiter {
    /** @param {{maxActive: number, maxQueue: number}} opts */
    constructor({maxActive, maxQueue}) {
        this.maxActive = maxActive;
        this.maxQueue = maxQueue;
        this.active = 0;
        this.waiting = [];
    }

    stats() {
        return {active: this.active, waiting: this.waiting.length, maxActive: this.maxActive, maxQueue: this.maxQueue};
    }

    /**
     * Run fn when a slot is free.
     * @template T
     * @param {() => Promise<T>} fn
     * @param {{signal?: AbortSignal}} [opts]  aborting while queued removes the job (code "cancelled")
     * @returns {Promise<T>}
     */
    async run(fn, {signal} = {}) {
        if (this.active >= this.maxActive) {
            if (this.waiting.length >= this.maxQueue) {
                throw new ApiError(429, 'busy', 'The renderer is busy. Try again shortly.', {
                    headers: {'Retry-After': String(RETRY_AFTER_SECONDS)},
                });
            }
            await new Promise((resolve, reject) => {
                const entry = {resolve, reject};
                this.waiting.push(entry);
                if (signal) {
                    const onAbort = () => {
                        const i = this.waiting.indexOf(entry);
                        if (i !== -1) {
                            this.waiting.splice(i, 1);
                            reject(new ApiError(499, 'cancelled', 'The request was cancelled.'));
                        }
                    };
                    if (signal.aborted) onAbort();
                    else signal.addEventListener('abort', onAbort, {once: true});
                }
            });
        } else {
            this.active++;
        }
        try {
            return await fn();
        } finally {
            const next = this.waiting.shift();
            // The slot passes straight to the next job, so active stays the same.
            if (next) next.resolve();
            else this.active--;
        }
    }
}
