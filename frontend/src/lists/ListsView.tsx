import { useState } from 'react'

import { useListReorder } from './dragReorder'
import type { GroceryList, ListClearScope } from './types'

interface Props {
  list: GroceryList | null
  recentItems: string[]
  onAdd: (name: string) => void
  onToggle: (itemId: string, checked: boolean) => void
  onRemove: (itemId: string) => void
  onClear: (scope: ListClearScope) => void
  /** Commit a drag-reorder — item ids in the new order (persisted server-side). */
  onReorder: (orderedIds: string[]) => void
  /** Privacy mode: show the shape (how many to get, "Got it" count) but not the
   *  item names, and take away every control. See docs/privacy-mode-plan.md. */
  redacted?: boolean
}

const REDACTED = '•••'

export function ListsView({
  list,
  recentItems,
  onAdd,
  onToggle,
  onRemove,
  onClear,
  onReorder,
  redacted = false,
}: Props) {
  const [confirmingClear, setConfirmingClear] = useState(false)
  const items = list?.items ?? []
  const nameOf = (name: string) => (redacted ? REDACTED : name)
  const unchecked = items.filter((item) => !item.checked)
  const checked = items.filter((item) => item.checked)
  const checkedIds = checked.map((item) => item.id)

  const reorder = useListReorder(
    unchecked.map((item) => item.id),
    (orderedIds) => onReorder([...orderedIds, ...checkedIds]),
  )
  const uncheckedById = new Map(unchecked.map((item) => [item.id, item]))
  const uncheckedOrder = (reorder.order ?? unchecked.map((item) => item.id))
    .map((id) => uncheckedById.get(id))
    .filter((item): item is (typeof unchecked)[number] => !!item)
  const canDrag = !redacted && unchecked.length > 1
  const onList = new Set(items.map((item) => item.name.trim().toLowerCase()))
  const quickAdd = recentItems.filter((name) => !onList.has(name.trim().toLowerCase())).slice(0, 12)

  const heading =
    unchecked.length === 0
      ? items.length === 0
        ? 'Nothing on the list'
        : 'All done'
      : `${unchecked.length} to get`

  return (
    <div className="lists-view">
      <div className="lists-panel">
        <div className="lists-heading">
          <div>
            <p className="section-kicker">{list?.title ?? 'Grocery'}</p>
            <h2>{heading}</h2>
          </div>
          <div className="lists-heading-actions">
            {!redacted && checked.length > 0 && (
              <button className="lists-clear-checked" onClick={() => onClear('checked')}>
                Clear checked
              </button>
            )}
            {!redacted && items.length > 0 && (
              <button
                className="lists-overflow"
                aria-label="Clear the whole list"
                aria-expanded={confirmingClear}
                onClick={() => setConfirmingClear((open) => !open)}
              >
                ⋯
              </button>
            )}
            {confirmingClear && (
              <div className="lists-confirm" role="dialog" aria-label="Clear the whole list">
                <span>Clear all {items.length}?</span>
                <button
                  onClick={() => {
                    setConfirmingClear(false)
                    onClear('all')
                  }}
                >
                  Clear all
                </button>
                <button className="quiet-action" onClick={() => setConfirmingClear(false)}>
                  Keep
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="lists-body">
          {items.length === 0 ? (
            <div className="lists-empty">
              <strong>The grocery list is empty.</strong>
              <small>Say “Mission Control, add milk to the grocery list”, or tap a recent item.</small>
            </div>
          ) : (
            <>
              <ul className="lists-items" ref={reorder.containerRef}>
                {uncheckedOrder.map((item) => (
                  <li
                    key={item.id}
                    data-reorder-id={item.id}
                    className={`lists-row${reorder.draggingId === item.id ? ' dragging' : ''}`}
                  >
                    {canDrag && (
                      <button
                        className="lists-row-grip"
                        aria-label={`Reorder ${item.name}`}
                        style={{ touchAction: 'none' }}
                        {...reorder.handleProps(item.id)}
                      >
                        <span aria-hidden>⠿</span>
                      </button>
                    )}
                    <button
                      className="lists-row-check"
                      aria-label={redacted ? 'Hidden item' : `Check off ${item.name}`}
                      disabled={redacted}
                      onClick={() => onToggle(item.id, true)}
                    >
                      <span className="lists-checkbox" aria-hidden />
                      <span className="lists-row-name">
                        {nameOf(item.name)}
                        {!redacted && item.note && <small>{item.note}</small>}
                      </span>
                    </button>
                    {!redacted && (
                      <button
                        className="lists-row-remove"
                        aria-label={`Remove ${item.name}`}
                        onClick={() => onRemove(item.id)}
                      >
                        ×
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {checked.length > 0 && (
                <div className="lists-got">
                  <p className="section-kicker">Got it · {checked.length}</p>
                  <div className="lists-got-items">
                    {checked.map((item) => (
                      <button
                        key={item.id}
                        className="lists-got-item"
                        aria-label={redacted ? 'Hidden item' : `Put ${item.name} back on the list`}
                        disabled={redacted}
                        onClick={() => onToggle(item.id, false)}
                      >
                        {nameOf(item.name)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {!redacted && quickAdd.length > 0 && (
          <div className="lists-quick-add">
            <p className="section-kicker">Add again</p>
            <div className="lists-quick-add-grid">
              {quickAdd.map((name) => (
                <button key={name} onClick={() => onAdd(name)}>
                  {name}
                </button>
              ))}
            </div>
            <small>Say “Mission Control, add …” for something new.</small>
          </div>
        )}
      </div>
    </div>
  )
}
