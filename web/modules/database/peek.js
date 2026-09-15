// Row detail: side peek panel and full-page row. Every property is editable, plus a notes field.

import { h, debounce } from '../../lib/ui.js'
import { icon } from '../../lib/icons.js'
import { typeOf, propIcon, renderValue, startEdit, hasDisplayValue } from './types.js'
import { typePicker, propertyMenu } from './menus.js'

export function createRowPanel(ctx, rowId, { mode = 'peek', onClose, onOpenPage, onBack, focusTitle } = {}) {
  const { store } = ctx
  const titleProp = () => store.properties.find((p) => p.type === 'title')
  const row = () => store.rowById.get(rowId)
  let editingProp = null
  let fieldsSig = ''

  const title = h('textarea', { class: 'db-row-title', rows: 1, placeholder: 'Untitled', 'aria-label': 'Title', spellcheck: 'false' })
  const fields = h('div', { class: 'db-fields' })
  const notes = h('textarea', { class: 'db-notes', placeholder: 'Add notes...', 'aria-label': 'Notes' })
  const addProp = h('button', { type: 'button', class: 'db-field-add' }, icon('plus', { size: 14 }), h('span', {}, 'Add a property'))

  const saveTitle = () => {
    const tp = titleProp()
    const r = row()
    if (!tp || !r) return
    const v = title.value.replace(/\n/g, ' ').trim()
    if (v !== (r.values[tp.id] || '')) store.updateValues(rowId, { [tp.id]: v || null }).catch(() => {})
  }
  const liveTitle = debounce(saveTitle, 400)
  title.addEventListener('input', () => {
    autosize(title)
    liveTitle()
  })
  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      liveTitle.cancel()
      saveTitle()
      fields.querySelector('.db-field-value')?.focus()
    }
  })
  title.addEventListener('blur', () => {
    liveTitle.cancel()
    saveTitle()
  })

  const saveNotes = () => {
    const r = row()
    if (r && notes.value !== r.notes) store.updateNotes(rowId, notes.value)
  }
  const liveNotes = debounce(saveNotes, 500)
  notes.addEventListener('input', () => {
    autosize(notes)
    liveNotes()
  })
  notes.addEventListener('blur', () => {
    liveNotes.cancel()
    saveNotes()
  })

  addProp.addEventListener('click', () => typePicker(addProp, {
    title: 'New property',
    onPick: async (type) => {
      const p = await store.createProperty({ type }).catch(() => null)
      if (!p) return
      requestAnimationFrame(() => {
        const label = fields.querySelector(`.db-field[data-prop="${p.id}"] .db-field-label`)
        if (label) propertyMenu(label, p, ctx, { focusName: true })
      })
    },
  }))

  function renderFields() {
    const r = row()
    if (!r) return
    const props = store.properties.filter((p) => p.type !== 'title')
    const sig = `${store.schemaVersion}`
    if (sig !== fieldsSig) {
      fieldsSig = sig
      fields.replaceChildren(...props.map((p) => {
        const label = h('button', { type: 'button', class: 'db-field-label', title: p.name }, propIcon(p, 14), h('span', { class: 'db-field-name' }, p.name))
        label.addEventListener('click', () => propertyMenu(label, store.propById.get(p.id) || p, ctx))
        const value = h('div', { class: `db-field-value${typeOf(p).readOnly ? ' is-readonly' : ''}`, tabindex: typeOf(p).readOnly ? '-1' : '0', dataset: { prop: p.id, type: p.type }, role: 'button', 'aria-label': p.name })
        const open = () => {
          if (editingProp || typeOf(p).readOnly) return
          const cur = store.propById.get(p.id)
          editingProp = p.id
          const handle = startEdit({
            cell: value, prop: cur, row: row(), store,
            onDone: () => {
              editingProp = null
              fill(value, cur)
            },
          })
          if (!handle && typeOf(cur).edit === 'toggle') editingProp = null
        }
        value.addEventListener('click', (e) => {
          if (!e.target.closest('a') && !e.target.closest('.db-inline-input')) open()
        })
        value.addEventListener('keydown', (e) => {
          if ((e.key === 'Enter' || e.key === ' ') && e.target === value) (e.preventDefault(), open())
        })
        return h('div', { class: 'db-field', dataset: { prop: p.id } }, label, value)
      }))
    }
    for (const value of fields.querySelectorAll('.db-field-value')) {
      if (value.dataset.prop === editingProp) continue
      fill(value, store.propById.get(value.dataset.prop))
    }
  }

  function fill(value, p) {
    const r = row()
    if (!r || !p || value.classList.contains('is-editing')) return
    const content = typeOf(p).edit === 'toggle' || hasDisplayValue(r, p) ? renderValue(r, p, store) : null
    value.replaceChildren(content || h('span', { class: 'db-field-empty' }, 'Empty'))
  }

  function refresh(change = {}) {
    const r = row()
    if (!r) return onClose?.()
    if (change.kind === 'row' && change.rowId !== rowId) return
    const tp = titleProp()
    if (document.activeElement !== title) {
      title.value = tp ? r.values[tp.id] || '' : ''
      autosize(title)
    }
    if (document.activeElement !== notes && notes.value !== r.notes) {
      notes.value = r.notes || ''
      autosize(notes)
    }
    if (!change.notesOnly) renderFields()
  }

  const bar = mode === 'peek'
    ? h('div', { class: 'db-peek-bar' },
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-icon db-peek-close', title: 'Close', 'aria-label': 'Close', onClick: () => onClose?.() }, icon('chevrons-left', { size: 16, className: 'db-flip' })),
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm db-open-page', onClick: () => onOpenPage?.() }, icon('external-link', { size: 14 }), h('span', { class: 'btn-label' }, 'Open as page')),
      h('span', { class: 'db-opt-spacer' }),
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-icon db-row-more', title: 'More', 'aria-label': 'More actions', onClick: (e) => ctx.rowMenu(e.currentTarget, rowId, { inPanel: true }) }, icon('more', { size: 16 })))
    : h('div', { class: 'db-page-bar' },
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm db-back', onClick: () => onBack?.() }, icon('chevron-left', { size: 14 }), h('span', { class: 'btn-label' }, `Back to ${ctx.view()?.name || 'database'}`)),
      h('span', { class: 'db-opt-spacer' }),
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-icon db-row-more', title: 'More', 'aria-label': 'More actions', onClick: (e) => ctx.rowMenu(e.currentTarget, rowId, { inPanel: true }) }, icon('more', { size: 16 })))

  const el = h('div', { class: mode === 'peek' ? 'db-peek' : 'db-row-page', role: mode === 'peek' ? 'complementary' : 'region', 'aria-label': 'Row details', dataset: { rowId } },
    bar,
    h('div', { class: 'db-row-scroll' },
      h('div', { class: 'db-row-content' },
        title, fields, addProp,
        h('div', { class: 'db-notes-wrap' }, h('div', { class: 'db-notes-label' }, 'Notes'), notes))))

  refresh()
  requestAnimationFrame(() => {
    autosize(title)
    autosize(notes)
    if (focusTitle) title.focus()
  })

  return {
    el,
    rowId,
    refresh,
    destroy() {
      liveTitle.cancel()
      liveNotes.cancel()
      if (document.activeElement === title) saveTitle()
      if (document.activeElement === notes) saveNotes()
      el.remove()
    },
  }
}

function autosize(ta) {
  ta.style.height = 'auto'
  ta.style.height = `${ta.scrollHeight}px`
}
