type ThemeRefreshListener = (theme: unknown) => void;

const listeners = new Set<ThemeRefreshListener>();

/** Subscribe to live theme rebuilds (mode/accent changes). Returns unsubscribe. */
export function subscribe_theme_refresh(listener: ThemeRefreshListener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Notify subscribers after applyDynamicTheme updates the live Theme instance. */
export function notify_theme_refresh(theme: unknown): void {
	for (const listener of listeners) {
		listener(theme);
	}
}