/** Mirrors pi-coding-agent `findExactModelReferenceMatch` for /model submit handling. */
export function find_exact_model_reference<T extends { provider: string; id: string; name?: string }>(
	modelReference: string,
	availableModels: T[],
): T | undefined {
	const trimmedReference = modelReference.trim();
	if (!trimmedReference) return undefined;
	const normalizedReference = trimmedReference.toLowerCase();
	const canonicalMatches = availableModels.filter(
		(model) => `${model.provider}/${model.id}`.toLowerCase() === normalizedReference,
	);
	if (canonicalMatches.length === 1) return canonicalMatches[0];
	if (canonicalMatches.length > 1) return undefined;
	const slashIndex = trimmedReference.indexOf("/");
	if (slashIndex !== -1) {
		const provider = trimmedReference.substring(0, slashIndex).trim();
		const modelId = trimmedReference.substring(slashIndex + 1).trim();
		if (provider && modelId) {
			const providerMatches = availableModels.filter(
				(model) =>
					model.provider.toLowerCase() === provider.toLowerCase() &&
					model.id.toLowerCase() === modelId.toLowerCase(),
			);
			if (providerMatches.length === 1) return providerMatches[0];
			if (providerMatches.length > 1) return undefined;
		}
	}
	const idMatches = availableModels.filter(
		(model) => model.id.toLowerCase() === normalizedReference,
	);
	return idMatches.length === 1 ? idMatches[0] : undefined;
}
