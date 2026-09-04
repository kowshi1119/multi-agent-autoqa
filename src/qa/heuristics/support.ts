import type { ElementTarget, FormSummary, InteractiveElement, Observation, QaAction, WidgetType } from "../../types.js";

export const FILLABLE_TEXT_TYPES: WidgetType[] = ["text_field", "email_field", "search_field", "textarea"];

export function isUsableWidget(element: InteractiveElement | undefined, allowed: WidgetType[]): element is InteractiveElement {
  return Boolean(element && element.visible && element.enabled !== false && allowed.includes(element.widgetType));
}

export function toElementTarget(el: InteractiveElement): ElementTarget {
  const target: ElementTarget = {};
  if (el.role) target.role = el.role;
  if (el.name) target.name = el.name;
  else if (el.label) target.label = el.label;
  return target;
}

/** The form (if any) that contains this element, used to find its submit control. */
export function findFormFor(observation: Observation, element: InteractiveElement): FormSummary | undefined {
  return observation.forms.find((form) =>
    form.fields.some((field) => field.role === element.role && (field.name ?? field.label) === (element.name ?? element.label))
  );
}

/**
 * Builds a [fill, click-submit] action sequence: fill the target element,
 * then click its enclosing form's submit control if one exists. Shared by
 * every fillable-field heuristic (H01-H09) so the "submit after filling"
 * decision lives in one place.
 */
export function buildFillAndMaybeSubmit(
  observation: Observation,
  element: InteractiveElement,
  value: string
): QaAction[] {
  const actions: QaAction[] = [{ type: "fill", target: toElementTarget(element), value }];
  const form = findFormFor(observation, element);
  if (form?.submitControl) {
    actions.push({ type: "click", target: toElementTarget(form.submitControl) });
  }
  return actions;
}
