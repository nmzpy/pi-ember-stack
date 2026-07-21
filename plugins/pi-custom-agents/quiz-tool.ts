import { Type } from "typebox";
import {
	type Component,
	type EditorTheme,
	type TUI,
	Editor,
	Key,
	Text,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type {
	ExtensionAPI,
	ExtensionContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { chatboxBorderColor, requestTuiRender } from "../pi-ember-ui/index.ts";
import { colorize, setQuizActive } from "../pi-ember-ui/mode-colors.ts";

export interface QuizOption {
	value: string;
	label: string;
	description?: string;
	/** Optional hex color applied to the option when selected. */
	selectedColor?: string;
}

export interface QuizQuestion {
	id: string;
	label?: string;
	prompt: string;
	options: QuizOption[];
}

interface QuizAnswer {
	id: string;
	value: string;
	label: string;
	wasCustom: boolean;
}

interface QuizResult {
	answers: QuizAnswer[];
	cancelled: boolean;
}

/**
 * Single canonical serializer for the model-facing quiz result.
 * Emits one inline line per answer, pairing the answer with its question's
 * label (or id fallback) and full prompt so the model has the same context
 * the user saw. Question metadata is sourced only from `params.questions`
 * (SSOT) — never mirrored onto `QuizAnswer`.
 */
export function format_answers_for_model(
	questions: QuizQuestion[],
	answers: QuizAnswer[],
): string {
	const by_id = new Map<string, QuizQuestion>();
	for (const q of questions) by_id.set(q.id, q);
	return answers
		.map((answer) => {
			const q = by_id.get(answer.id);
			const q_title = q?.label ?? q?.id ?? answer.id;
			const q_prompt = q?.prompt ?? "";
			const marker = answer.wasCustom ? "custom" : "selected";
			return `Q(${q_title}): ${q_prompt} → A(${marker}): ${answer.label}`;
		})
		.join("\n");
}

const QuizParams = Type.Object({
	questions: Type.Array(
		Type.Object({
			id: Type.String({ description: "Unique question identifier" }),
			label: Type.Optional(Type.String({ description: "Short label for the question" })),
			prompt: Type.String({ description: "The full question to show the user" }),
			options: Type.Array(
				Type.Object({
					value: Type.String({ description: "Value returned for this option" }),
					label: Type.String({ description: "Option label shown to the user" }),
					description: Type.Optional(Type.String({ description: "Optional option explanation" })),
				}),
			),
		}),
	),
});

export interface AskQuizOptions {
	/** Whether to append the automatic "None" option to each question. Default true. */
	includeNone?: boolean;
}

export async function askQuiz(
	ctx: ExtensionContext,
	title: string,
	questions: QuizQuestion[],
	options?: AskQuizOptions,
): Promise<QuizAnswer[] | undefined> {
	if (!ctx.hasUI || questions.length === 0) return undefined;
	const includeNone = options?.includeNone !== false;

	const result = await ctx.ui.custom(
		(_tui: TUI, theme: Theme, _keybindings: KeybindingsManager, done: (result: QuizResult) => void) => {
			setQuizActive(true);
			requestTuiRender();
			const finish = (r: QuizResult): void => {
				setQuizActive(false);
				requestTuiRender();
				done(r);
			};
			let questionIndex = 0;
			let optionIndex = 0;
			let cachedLines: string[] | undefined;
			let cachedWidth: number | undefined;
			let inputMode = false;
			const answers = new Map<string, QuizAnswer>();

			const NONE_VALUE = "__none__";
			const NONE_DESC = "Specify the proper answer";

			const editorTheme: EditorTheme = {
				borderColor: (s: string) => theme.fg("text", s),
				selectList: {
					selectedPrefix: (t: string) => theme.fg("text", t),
					selectedText: (t: string) => theme.fg("text", t),
					description: (t: string) => theme.fg("muted", t),
					scrollInfo: (t: string) => theme.fg("dim", t),
					noMatch: (t: string) => theme.fg("warning", t),
				},
			};
			const editor = new Editor(_tui, editorTheme);

			editor.onSubmit = (value: string) => {
				if (!inputMode) return;
				const trimmed = value.trim();
				if (!trimmed) {
					inputMode = false;
					editor.setText("");
					refresh();
					return;
				}
				const q = currentQuestion();
				answers.set(q.id, {
					id: q.id,
					value: trimmed,
					label: trimmed,
					wasCustom: true,
				});
				inputMode = false;
				editor.setText("");
				advance();
			};

			function refresh(): void {
				cachedLines = undefined;
				cachedWidth = undefined;
				_tui.requestRender();
			}

			function addWrapped(lines: string[], text: string, width: number): void {
				lines.push(...wrapTextWithAnsi(text, width));
			}

			function addWrappedWithPrefix(
				lines: string[],
				prefix: string,
				text: string,
				width: number,
			): void {
				const prefixWidth = visibleWidth(prefix);
				if (prefixWidth >= width) {
					addWrapped(lines, `${prefix}${text}`, width);
					return;
				}
				const wrapped = wrapTextWithAnsi(text, width - prefixWidth);
				const continuationPrefix = " ".repeat(prefixWidth);
				for (let i = 0; i < wrapped.length; i++) {
					const line = `${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`;
					// Ensure the assembled line never exceeds the terminal width;
					// wrapTextWithAnsi can produce a line whose visible width equals
					// the budget, but when joined with the prefix it can still overrun.
					lines.push(visibleWidth(line) > width ? truncateToWidth(line, width) : line);
				}
			}

			function currentQuestion(): QuizQuestion {
				return questions[questionIndex];
			}

			function displayOptions(): { option: QuizOption; isNone: boolean }[] {
				const q = currentQuestion();
				const result: { option: QuizOption; isNone: boolean }[] = q.options.map(
					(option) => ({ option, isNone: false }),
				);
				if (includeNone) {
					result.push({
						option: { value: NONE_VALUE, label: "None", description: NONE_DESC },
						isNone: true,
					});
				}
				return result;
			}

			function advance(): void {
				if (questionIndex === questions.length - 1) {
					finish({ answers: Array.from(answers.values()), cancelled: false });
					return;
				}
				questionIndex++;
				optionIndex = 0;
				refresh();
			}

			function render(width: number): string[] {
				const renderWidth = Math.max(1, width);
				if (cachedLines && cachedWidth === renderWidth) return cachedLines.slice();
				const question = currentQuestion();
				const lines: string[] = [chatboxBorderColor("─".repeat(renderWidth))];
				addWrappedWithPrefix(lines, " ", theme.fg("text", theme.bold(title)), renderWidth);
				addWrappedWithPrefix(
					lines,
					" ",
					theme.fg("muted", `${questionIndex + 1}/${questions.length} ${question.label ?? ""}`),
					renderWidth,
				);
				lines.push("");
				addWrappedWithPrefix(lines, " ", theme.fg("text", question.prompt), renderWidth);
				lines.push("");

				if (inputMode) {
					for (let i = 0; i < question.options.length; i++) {
						const option = question.options[i];
						const prefix = "  ";
						addWrappedWithPrefix(
							lines,
							prefix,
							theme.fg("muted", `${i + 1}. ${option.label}`),
							renderWidth,
						);
					}
					const noneIdx = question.options.length;
					addWrappedWithPrefix(
						lines,
						theme.fg("text", "> "),
						theme.fg("text", `${noneIdx + 1}. None ✎`),
						renderWidth,
					);
					lines.push("");
					addWrappedWithPrefix(lines, " ", theme.fg("muted", "Your answer:"), renderWidth);
					for (const line of editor.render(Math.max(1, renderWidth - 2))) {
						lines.push(` ${line}`);
					}
					lines.push(chatboxBorderColor("─".repeat(renderWidth)));
					cachedLines = lines;
					cachedWidth = renderWidth;
					return lines.slice();
				}

				const opts = displayOptions();
				for (let i = 0; i < opts.length; i++) {
					const { option, isNone } = opts[i];
					const selected = i === optionIndex;
					const labelSuffix = isNone && inputMode ? " ✎" : "";
					const label = `${i + 1}. ${option.label}${labelSuffix}`;
					let prefix: string;
					let painted: string;
					if (selected && option.selectedColor) {
						prefix = colorize(option.selectedColor, "> ");
						painted = colorize(option.selectedColor, label);
					} else if (selected) {
						prefix = theme.fg("text", "> ");
						painted = theme.fg("text", label);
					} else {
						prefix = "  ";
						painted = theme.fg("dim", label);
					}
					addWrappedWithPrefix(
						lines,
						prefix,
						painted,
						renderWidth,
					);
					if (option.description) {
						addWrappedWithPrefix(
							lines,
							"     ",
							theme.fg("muted", option.description),
							renderWidth,
						);
					}
				}

				lines.push(chatboxBorderColor("─".repeat(renderWidth)));
				cachedLines = lines;
				cachedWidth = renderWidth;
				return lines.slice();
			}

			function handleInput(data: string): void {
				if (inputMode) {
					if (matchesKey(data, Key.escape)) {
						inputMode = false;
						editor.setText("");
						refresh();
						return;
					}
					editor.handleInput(data);
					refresh();
					return;
				}

				const question = currentQuestion();
				const opts = displayOptions();
				if (matchesKey(data, Key.up)) {
					optionIndex = Math.max(0, optionIndex - 1);
					refresh();
					return;
				}
				if (matchesKey(data, Key.down)) {
					optionIndex = Math.min(opts.length - 1, optionIndex + 1);
					refresh();
					return;
				}
				if (matchesKey(data, Key.left) && questionIndex > 0) {
					questionIndex--;
					optionIndex = 0;
					refresh();
					return;
				}
				if (
					matchesKey(data, Key.right) &&
					answers.has(question.id) &&
					questionIndex < questions.length - 1
				) {
					questionIndex++;
					optionIndex = 0;
					refresh();
					return;
				}
				if (matchesKey(data, Key.enter)) {
					const { option, isNone } = opts[optionIndex];
					if (isNone) {
						inputMode = true;
						editor.setText("");
						refresh();
						return;
					}
					answers.set(question.id, {
						id: question.id,
						value: option.value,
						label: option.label,
						wasCustom: false,
					});
					advance();
					return;
				}
				if (matchesKey(data, Key.escape)) {
					finish({ answers: [], cancelled: true });
				}
			}

			return { render, invalidate: refresh, handleInput };
		},
	);

	return result.cancelled ? undefined : result.answers;
}

export function registerQuizTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "quiz",
		label: "Quiz",
		description: "Ask the user one or more decision questions inline before continuing.",
		parameters: QuizParams,
		executionMode: "sequential",
		renderShell: "self",
		async execute(
			_toolCallId: string,
			params: { questions: QuizQuestion[] },
			_signal: AbortSignal,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			if (ctx.mode !== "tui") {
				return {
					content: [
						{
							type: "text",
							text: "Error: Quiz UI is only available in interactive mode.",
						},
					],
					details: { answers: [], cancelled: true },
				};
			}
			if (
				params.questions.length === 0 ||
				params.questions.some((question) => question.options.length === 0)
			) {
				return {
					content: [
						{
							type: "text",
							text: "Error: Quiz questions require at least one option.",
						},
					],
					details: { answers: [], cancelled: true },
				};
			}

			const answers = await askQuiz(ctx, "Quiz", params.questions);
			return {
				content: [
					{
						type: "text",
						text:
							answers === undefined
								? "User cancelled the quiz."
								: format_answers_for_model(params.questions, answers),
					},
				],
				details: { answers: answers ?? [], cancelled: answers === undefined },
			};
		},
		renderCall(args: { questions?: QuizQuestion[] }, _theme: Theme): Component {
			// Compact bullet row, consistent with every other tool. The
			// interactive overlay (askQuiz) owns the two chatbox
			// horizontal rules the user sees; wrapping the transcript tag in
			// chatboxBorderContainer here added a third/fourth `─` line.
			const count = args.questions?.length ?? 0;
			return new Text(
				`${_theme.fg("muted", "• ")}${_theme.fg("dim", _theme.bold("quiz "))}${_theme.fg("muted", `${count} question${count === 1 ? "" : "s"}`)}`,
				0,
				0,
			);
		},
		renderResult(
			result: { details?: { answers?: QuizAnswer[]; cancelled?: boolean } },
			_options: unknown,
			theme: Theme,
			context: { args?: { questions?: QuizQuestion[] } },
		): Component {
			const details = result.details;
			if (details?.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const answers = details?.answers ?? [];
			const questions = context?.args?.questions ?? [];
			return new Text(
				answers
					.map((answer) => {
						const q = questions.find((q: QuizQuestion) => q.id === answer.id);
						const q_title = q?.label ?? q?.id ?? answer.id;
						const q_prompt = q?.prompt ?? "";
						const prefix = answer.wasCustom ? "(custom) " : "";
						const questionText = `${q_title}: ${q_prompt}`;
						const answerText = `${prefix}${answer.label}`;
						return `${theme.fg("dim", `${questionText} → `)}${theme.fg("text", answerText)}`;
					})
					.join("\n"),
				0,
				0,
			);
		},
	});
}
