import { Type } from "typebox";
import {
	type EditorTheme,
	Editor,
	Key,
	Text,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { requestTuiRender } from "../pi-ember-ui/index.ts";
import { setQuestionnaireActive } from "../pi-ember-ui/mode-colors.ts";

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

/**
 * Single canonical serializer for the model-facing questionnaire result.
 * Emits one inline line per answer, pairing the answer with its question's
 * label (or id fallback) and full prompt so the model has the same context
 * the user saw. Question metadata is sourced only from `params.questions`
 * (SSOT) — never mirrored onto `QuestionnaireAnswer`.
 */
export function format_answers_for_model(
	questions: QuestionnaireQuestion[],
	answers: QuestionnaireAnswer[],
): string {
	const by_id = new Map<string, QuestionnaireQuestion>();
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
			setQuestionnaireActive(true);
			requestTuiRender();
			const finish = (r: QuestionnaireResult): void => {
				setQuestionnaireActive(false);
				requestTuiRender();
				done(r);
			};
			let questionIndex = 0;
			let optionIndex = 0;
			let cachedLines: string[] | undefined;
			let inputMode = false;
			const answers = new Map<string, QuestionnaireAnswer>();

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
					lines.push(
						visibleWidth(line) > width ? truncateToWidth(line, width) : line,
					);
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
					finish({ answers: Array.from(answers.values()), cancelled: false });
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
				const lines: string[] = [theme.fg("text", "─".repeat(renderWidth))];
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
							theme.fg("dim", `${i + 1}. ${option.label}`),
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
					lines.push("");
					addWrappedWithPrefix(
						lines,
						" ",
						theme.fg("dim", "Enter to submit • Esc back to options"),
						renderWidth,
					);
					lines.push(theme.fg("text", "─".repeat(renderWidth)));
					cachedLines = lines;
					return lines;
				}

				const opts = displayOptions();
				for (let i = 0; i < opts.length; i++) {
					const { option, isNone } = opts[i];
					const selected = i === optionIndex;
					const prefix = selected ? theme.fg("text", "> ") : "  ";
					const color = selected ? "text" : "muted";
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
				lines.push(theme.fg("text", "─".repeat(renderWidth)));
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
					finish({ answers: [], cancelled: true });
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
								: format_answers_for_model(params.questions, answers),
					},
				],
				details: { answers: answers ?? [], cancelled: answers === undefined },
			};
		},
		renderCall(args: { questions?: QuestionnaireQuestion[] }, _theme: any): any {
			// Compact bullet row, consistent with every other tool. The
			// interactive overlay (askQuestionnaire) owns the two chatbox
			// horizontal rules the user sees; wrapping the transcript tag in
			// chatboxBorderContainer here added a third/fourth `─` line.
			const count = args.questions?.length ?? 0;
			return new Text(
				`${_theme.fg("muted", "• ")}${_theme.fg("toolTitle", _theme.bold("questionnaire "))}${_theme.fg("muted", `${count} question${count === 1 ? "" : "s"}`)}`,
				0,
				0,
			);
		},
		renderResult(
			result: any,
			_options: unknown,
			theme: any,
			context: { args?: { questions?: QuestionnaireQuestion[] } },
		): any {
			const details = result.details as
				| {
						answers?: QuestionnaireAnswer[];
						cancelled?: boolean;
				  }
				| undefined;
			if (details?.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const answers = details?.answers ?? [];
			const questions = context?.args?.questions ?? [];
			return new Text(
				answers
					.map((answer) => {
						const q = questions.find((q: QuestionnaireQuestion) => q.id === answer.id);
						const q_title = q?.label ?? q?.id ?? answer.id;
						const q_prompt = q?.prompt ?? "";
						const prefix = answer.wasCustom ? "(custom) " : "";
						const label = `${q_title}: ${q_prompt} → ${prefix}${answer.label}`;
						return `${theme.fg("success", "Selected: ")}${theme.fg("text", label)}`;
					})
					.join("\n"),
				0,
				0,
			);
		},
	});
}
