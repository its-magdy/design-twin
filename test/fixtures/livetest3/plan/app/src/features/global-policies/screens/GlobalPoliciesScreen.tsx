import { useMemo, useState } from 'react';
import { PageTitle } from '../../../components/PageTitle';
import { SearchInput } from '../../../components/SearchInput';
import { Button } from '../../../components/Button';
import { FilterButton } from '../../../components/FilterButton';
import { SearchAndFilter } from '../../../components/SearchAndFilter';
import { SquareButton } from '../../../components/SquareButton';
import { Modal } from '../../../components/Modal';
import { Icon } from '../../../components/Icon';
import { DataTable } from '../../../components/DataTable';
import type { Column } from '../../../components/DataTable';
import { PolicySection } from '../components/PolicySection';
import { StatusBadge, POLICY_STATUSES } from '../components/StatusBadge';
import type { PolicyStatus } from '../components/StatusBadge';
import { POLICY_SECTIONS } from '../data/policies';
import type { Policy } from '../data/policies';

/**
 * Figma frame `System Configurations` (1359:21337) — the sidebar calls it "Global Policies",
 * which is also the string in its `Page Title` (I20170:126629;72:3148).
 *
 * Column geometry is the design's own absolute x positions inside the 1032px table interior
 * (Policy Description 0 · Value 584.2 · Status 951.8), expressed as percentages so the table is
 * fluid — profiles/web-tailwind.md: "the frame's width is ONE viewport, not a fixed canvas".
 *
 * Chrome (sidebar/header/footer) comes from AppShell; this screen emits none of it.
 */
type StatusFilter = 'All' | PolicyStatus;

export function GlobalPoliciesScreen() {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('All');
  const [filterOpen, setFilterOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>(
    () => Object.fromEntries(POLICY_SECTIONS.map((s) => [s.id, s.defaultExpanded])),
  );
  const [overrides, setOverrides] = useState<Record<string, { value: string; status: PolicyStatus }>>({});
  const [editing, setEditing] = useState<{ sectionId: string; policy: Policy } | null>(null);
  const [draft, setDraft] = useState<{ value: string; status: PolicyStatus }>({ value: '', status: 'Hard' });

  const resolve = (p: Policy): Policy => ({ ...p, ...(overrides[p.id] ?? {}) });

  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    return POLICY_SECTIONS.map((s) => ({
      ...s,
      policies: s.policies
        .map(resolve)
        .filter((p) => (q ? p.description.toLowerCase().includes(q) : true))
        .filter((p) => (statusFilter === 'All' ? true : p.status === statusFilter)),
    }));
  }, [query, statusFilter, overrides]);

  const totalMatches = sections.reduce((n, s) => n + s.policies.length, 0);

  const columns: Column<Policy>[] = [
    {
      key: 'description',
      header: 'Policy Description',
      width: 56.389,
      headerNode: '18580:60862',
      render: (p) => p.description,
    },
    { key: 'value', header: 'Value', width: 33.981, headerNode: '18580:60860', render: (p) => p.value },
    {
      key: 'status',
      header: 'Status',
      width: 9.63,
      headerNode: '18580:60861',
      render: (p) => <StatusBadge status={p.status} />,
    },
  ];

  function openEdit(sectionId: string, policy: Policy) {
    setEditing({ sectionId, policy });
    setDraft({ value: policy.value, status: policy.status });
  }

  function saveEdit() {
    if (!editing) return;
    setOverrides((o) => ({ ...o, [editing.policy.id]: { value: draft.value, status: draft.status } }));
    setEditing(null);
  }

  return (
    <div className="flex min-h-full flex-1 flex-col" data-dt-node="18580:60745">
      <PageTitle title="Global Policies" data-dt-node="20170:126629" />

      {/* `Frame 1000004489` 18580:60747 — widthMode/heightMode both `fill`, hence flex-1 */}
      <div className="flex flex-1 flex-col gap-space-3 ps-space-4 pe-space-4" data-dt-node="18580:60747">
        {/* NERA `search and filter` 885:3006 — instance 20024:134073. All three BOOLEANs
            (`Show Date`, `show sorting`, `Segmented Control`) are false here too. */}
        <SearchAndFilter
          data-dt-node="20024:134073"
          leftNode="I20024:134073;1219:2564"
          search={
            <SearchInput
              label="Search policies"
              placeholder="Search by policy description"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              data-dt-node="I20024:134073;885:2724;880:3726"
              data-testid="policy-search"
            />
          }
          filter={
            <div className="relative">
              <FilterButton
                onClick={() => setFilterOpen((v) => !v)}
                aria-expanded={filterOpen}
                aria-haspopup="menu"
                data-dt-node="I20024:134073;885:2723"
                data-testid="policy-filter"
              />
              {filterOpen && (
                <div
                  role="menu"
                  aria-label="Filter by status"
                  data-testid="policy-filter-menu"
                  className="absolute z-20 mt-space-2 flex w-44 flex-col rounded-semantic-rounds-forms-rounded border border-borders-border bg-backgrounds-tags p-space-2 shadow-lg"
                >
                  {(['All', ...POLICY_STATUSES] as StatusFilter[]).map((s) => (
                    <button
                      key={s}
                      type="button"
                      role="menuitemradio"
                      aria-checked={statusFilter === s}
                      onClick={() => { setStatusFilter(s); setFilterOpen(false); }}
                      className={`rounded-m ps-space-3-paren pe-space-3-paren pt-1 pb-1 text-start text-font-size-text-sm leading-5 hover:bg-neutrals-neutral-100 ${
                        statusFilter === s ? 'text-primary-primary' : 'text-text-sub-titles'
                      }`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          }
        />

        {sections.map((section) => (
          <PolicySection
            key={section.id}
            id={section.id}
            title={section.title}
            icon={section.icon}
            node={section.node}
            headerNode={section.headerNode}
            contentNode={section.contentNode}
            iconSize={section.iconSize}
            iconNode={section.iconNode}
            titleNode={section.titleNode}
            buttonNode={section.buttonNode}
            expanded={expanded[section.id]}
            onToggle={() => setExpanded((e) => ({ ...e, [section.id]: !e[section.id] }))}
          >
            <DataTable<Policy>
              caption={`${section.title} policies`}
              columns={columns}
              rows={section.policies}
              rowKey={(p) => p.id}
              rowNode={(p) => p.node}
              emptyMessage="No policies match your search."
              data-dt-node={section.id === 'shift-specific' ? '18580:60858' : undefined}
              headerRowNode={section.id === 'shift-specific' ? '18580:60859' : undefined}
              headerClassName="h-14 bg-backgrounds-tags"
              headerCellPaddingClassName="py-space-3"
              lastRowFirstCellClassName=""
              lastRowLastCellClassName=""
              headerFirstCellClassName="ps-space-4 rounded-tl-lg"
              headerLastCellClassName="pe-space-4 rounded-tr-lg"
              rowClassName="h-[58px] bg-backgrounds-page-color hover:bg-backgrounds-row-hover focus-within:bg-backgrounds-row-hover focus-visible:bg-backgrounds-row-hover"
              /* `Frame 1000004107` 18580:60858 gap 8 -> 8px between header and every row;
                 the -my-2 cancels border-spacing's extra 8px at the table's top and bottom edges */
              bodyGapClassName="border-spacing-y-2 -my-[12px]"
              bodyCellClassName="py-space-3 align-middle text-font-size-text-sm leading-5 tracking-[0.1px] text-text-sub-titles"
              bodyFirstCellClassName="ps-space-4"
              bodyLastCellClassName="pe-space-4"
              rowActions={(p) => (
                <SquareButton
                  label={`Edit ${p.description}`}
                  size={36}
                  surface="main-section"
                  onClick={(e) => { e.stopPropagation(); openEdit(section.id, p); }}
                  data-dt-node={p.node === '18580:60874' ? '18580:60880' : undefined}
                  data-testid={`edit-${p.id}`}
                >
                  <Icon name="edit-2" size={18} preserveColor />
                </SquareButton>
              )}
            />
          </PolicySection>
        ))}

        {totalMatches === 0 && (
          <p className="pt-space-4 text-center text-font-size-text-sm text-text-sub-titles" data-testid="policies-empty">
            No policies match “{query}”{statusFilter !== 'All' ? ` with status ${statusFilter}` : ''}.
          </p>
        )}
      </div>

      {/*
        18580:60879 carries a real Figma reaction: on_click -> overlay -> "Popup" (14642:16079).
        That node was never exported, so the dialog's contents are the audit's default, not a design.
      */}
      <Modal
        open={editing !== null}
        title="Edit policy"
        onClose={() => setEditing(null)}
        footer={
          <>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button onClick={saveEdit} data-testid="policy-save">Save</Button>
          </>
        }
      >
        <p className="text-font-size-text-sm text-text-main-titles" data-testid="policy-edit-description">
          {editing?.policy.description}
        </p>
        <label className="flex flex-col gap-space-2">
          <span className="text-font-size-text-xs text-text-sub-titles">Value</span>
          <input
            value={draft.value}
            onChange={(e) => { const v = e.currentTarget.value; setDraft((d) => ({ ...d, value: v })); }}
            data-testid="policy-value-input"
            className="h-9 rounded-semantic-rounds-forms-rounded border border-borders-border bg-backgrounds-tags ps-space-3-paren pe-space-3-paren text-font-size-text-sm text-text-main-titles focus:border-primary-primary focus:outline-none"
          />
        </label>
        <fieldset className="flex flex-col gap-space-2">
          <legend className="text-font-size-text-xs text-text-sub-titles">Status</legend>
          <div className="flex items-center gap-space-3">
            {POLICY_STATUSES.map((s) => (
              <label key={s} className="flex cursor-pointer items-center gap-space-2">
                <input
                  type="radio"
                  name="policy-status"
                  value={s}
                  checked={draft.status === s}
                  onChange={() => setDraft((d) => ({ ...d, status: s }))}
                  data-testid={`policy-status-${s}`}
                  className="accent-primary-primary"
                />
                <StatusBadge status={s} />
              </label>
            ))}
          </div>
        </fieldset>
      </Modal>
    </div>
  );
}
