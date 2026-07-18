import { Type } from "typebox";
import {
	Box,
	type EditorTheme,
	Editor,
	Key,
	Text,
	matchesKey,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

export interface QuestionnaireOption {
	value: string;
	label: string;
	description?: string;
}

export interface QuestionnaireQuestion {
	id: string;
	label?: string;
	prompt: string;
	options: QuestionnaireOption[];
}

interface QuestionnaireAnswer {
	id: string;
	value: string;
	label: string;
	wasCustom: boolean;
}

interface QuestionnaireResult {
	answers: QuestionnaireAnswer[];
	cancelled: boolean;
}

const QuestionnaireParams = Type.Object({
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

export async function askQuestionnaire(
	ctx: any,
	title: string,
	questions: QuestionnaireQuestion[],
): Promise<QuestionnaireAnswer[] | undefined> {
	if (!ctx.hasUI || questions.length === 0) return undefined;

	const result = await ctx.ui.custom(
		(_tui: any, theme: any, _keybindings: any, done: (result: QuestionnaireResult) => void) => {
			let questionIndex = 0;
			let optionIndex = 0;
			let cachedLines: string[] | undefined;
			let inputMode = false;
			const answers = new Map<string, QuestionnaireAnswer>();

			const NONE_VALUE = "__none__";
			const NONE_DESC = "Specify the proper answer";

			const editorTheme: EditorTheme = {
				borderColor: (s: string) => theme.fg("accent", s),
				selectList: {
					selectedPrefix: (t: string) => theme.fg("accent", t),
					selectedText: (t: string) => theme.fg("accent", t),
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
					lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
				}
			}

			function currentQuestion(): QuestionnaireQuestion {
				return questions[questionIndex];
			}

			function displayOptions(): { option: QuestionnaireOption; isNone: boolean }[] {
				const q = currentQuestion();
				const result: { option: QuestionnaireOption; isNone: boolean }[] = q.options.map(
					(option) => ({ option, isNone: false }),
				);
				result.push({
					option: { value: NONE_VALUE, label: "None", description: NONE_DESC },
					isNone: true,
				});
				return result;
			}

			function advance(): void {
				if (questionIndex === questions.length - 1) {
					done({ answers: Array.from(answers.values()), cancelled: false });
					return;
				}
				questionIndex++;
				optionIndex = 0;
				refresh();
			}

			function render(width: number): string[] {
				if (cachedLines) return cachedLines;
				const renderWidth = Math.max(1, width);
				const question = currentQuestion();
				const lines: string[] = [theme.fg("accent", "─".repeat(renderWidth))];
				addWrappedWithPrefix(lines, " ", theme.fg("accent", theme.bold(title)), renderWidth);
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
							theme.fg("dim", `${i + 1}. ${option.label}`),
							renderWidth,
						);
					}
					const noneIdx = question.options.length;
					addWrappedWithPrefix(
						lines,
						theme.fg("accent", "> "),
						theme.fg("accent", `${noneIdx + 1}. None ✎`),
						renderWidth,
					);
					lines.push("");
					addWrappedWithPrefix(lines, " ", theme.fg("muted", "Your answer:"), renderWidth);
					for (const line of editor.render(Math.max(1, renderWidth - 2))) {
						lines.push(` ${line}`);
					}
					lines.push("");
					addWrappedWithPrefix(
						lines,
						" ",
						theme.fg("dim", "Enter to submit • Esc back to options"),
						renderWidth,
					);
					lines.push(theme.fg("accent", "─".repeat(renderWidth)));
					cachedLines = lines;
					return lines;
				}

				const opts = displayOptions();
				for (let i = 0; i < opts.length; i++) {
					const { option, isNone } = opts[i];
					const selected = i === optionIndex;
					const prefix = selected ? theme.fg("accent", "> ") : "  ";
					const color = selected ? "accent" : "text";
					const labelSuffix = isNone && inputMode ? " ✎" : "";
					addWrappedWithPrefix(
						lines,
						prefix,
						theme.fg(color, `${i + 1}. ${option.label}${labelSuffix}`),
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

				lines.push("");
				addWrappedWithPrefix(
					lines,
					" ",
					theme.fg("dim", "Up/Down navigate | Enter select | Left/Right revisit | Esc cancel"),
					renderWidth,
				);
				lines.push(theme.fg("accent", "─".repeat(renderWidth)));
				cachedLines = lines;
				return lines;
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
					done({ answers: [], cancelled: true });
				}
			}

			return { render, invalidate: refresh, handleInput };
		},
	);

	return result.cancelled ? undefined : result.answers;
}

export function registerQuestionnaireTool(pi: any): void {
	pi.registerTool({
		name: "questionnaire",
		label: "Questionnaire",
		description: "Ask the user one or more decision questions inline before continuing.",
		parameters: QuestionnaireParams,
		executionMode: "sequential",
		renderShell: "self",
		async execute(
			_toolCallId: string,
			params: { questions: QuestionnaireQuestion[] },
			_signal: AbortSignal,
			_onUpdate: unknown,
			ctx: any,
		) {
			if (ctx.mode !== "tui") {
				return {
					content: [
						{
							type: "text",
							text: "Error: Questionnaire UI is only available in interactive mode.",
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
							text: "Error: Questionnaire questions require at least one option.",
						},
					],
					details: { answers: [], cancelled: true },
				};
			}

			const answers = await askQuestionnaire(ctx, "Questionnaire", params.questions);
			return {
				content: [
					{
						type: "text",
						text:
							answers === undefined
								? "User cancelled the questionnaire."
								: answers
										.map((answer) =>
											answer.wasCustom
												? `${answer.id}: ${answer.label}`
												: `${answer.id}: ${answer.label}`,
										)
										.join("\n"),
					},
				],
				details: { answers: answers ?? [], cancelled: answers === undefined },
			};
		},
		renderCall(args: { questions?: QuestionnaireQuestion[] }, theme: any): any {
			const count = args.questions?.length ?? 0;
			const box = new Box(1, 1, (text: string) => theme.bg("userMessageBg", text));
			box.addChild(
				new Text(
					theme.fg("muted", "• ") +
						theme.fg("toolTitle", theme.bold("questionnaire ")) +
						theme.fg("muted", `${count} question${count === 1 ? "" : "s"}`),
					0,
					0,
				),
			);
			return box;
		},
		renderResult(result: any, _options: unknown, theme: any): any {
			const details = result.details as
				| {
						answers?: QuestionnaireAnswer[];
						cancelled?: boolean;
				  }
				| undefined;
			const box = new Box(1, 1, (text: string) => theme.bg("userMessageBg", text));
			if (details?.cancelled) {
				box.addChild(new Text(theme.fg("warning", "Cancelled"), 0, 0));
				return box;
			}
			const answers = details?.answers ?? [];
			box.addChild(
				new Text(
					answers
						.map((answer) => {
							const prefix = answer.wasCustom ? "(custom) " : "";
							const label = `${answer.id}: ${prefix}${answer.label}`;
							return `${theme.fg("success", "Selected: ")}${theme.fg("accent", label)}`;
						})
						.join("\n"),
					0,
					0,
				),
			);
			return box;
		},
	});
}
