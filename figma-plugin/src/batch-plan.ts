// What the create ops of the batch being resolved will make (creates.ts: createVariables, createStyles), so the ops after
// them can name it before it exists: a spec's or a patch's variable or text style (tree-refs.ts), and a source edit
// that names one (sources.ts, which refuses it with a pointer to the create op).
//
// Set by writes.ts while one batch resolves and runs, and cleared when it ends: writes run one at a time (an exclusive
// run, state.ts), so one plan is ever live. A planned item is only a new name: a name the file has already is found
// in the file, as it is today, and the create op updates that one in place. An item's `made` is filled when the create
// op runs, which is before the ops after it resolve the references they deferred (tree-refs `later`).

/** A variable or style a create op of the batch will make. */
export interface Planned<T> {
  name: string;
  /** the index of the create op */
  op: number;
  /** where it is made, for a sentence: "the collection 'Tokens'", "a text style" */
  where: string;
  /** a variable's type (checked against the field that names it before anything runs) */
  type?: VariableResolvedDataType;
  /** a style's kind */
  kind?: "PAINT" | "TEXT" | "EFFECT";
  /** the item, once the create op has made it */
  made: T | null;
}
export interface BatchPlan {
  variables: Array<Planned<Variable>>;
  styles: Array<Planned<PaintStyle | TextStyle | EffectStyle>>;
}

let current: BatchPlan | null = null;

/** Make `plan` the batch's (null: no batch is resolving). */
export function setBatchPlan(plan: BatchPlan | null): void {
  current = plan;
}
/** The new variables named exactly `name` that the batch's create ops will make. */
export function plannedVariables(name: string): Array<Planned<Variable>> {
  return current ? current.variables.filter((v) => v.name === name) : [];
}
/** The new styles named exactly `name` (of `kind`, when given) that the batch's create ops will make. */
export function plannedStyles(name: string, kind?: "PAINT" | "TEXT" | "EFFECT"): Array<Planned<PaintStyle | TextStyle | EffectStyle>> {
  return current ? current.styles.filter((s) => s.name === name && (kind === undefined || s.kind === kind)) : [];
}
/** "ops[2] makes it in the collection 'Tokens'": where a planned item comes from, for a refusal. */
export function plannedWhere(p: Planned<unknown>): string {
  return "ops[" + p.op + "] makes it " + p.where;
}
