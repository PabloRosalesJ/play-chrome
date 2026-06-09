const NOTEBOOK_STORAGE_KEY = 'playchrome_notebook'

let notebookCells = []
let cellIdCounter = 0

function generateCellId() {
  return 'cell-' + (++cellIdCounter)
}

function createCell(code = '') {
  return {
    id: generateCellId(),
    code,
    output: null,
    status: 'idle',
    createdAt: Date.now()
  }
}

function addCell(code = '') {
  const cell = createCell(code)
  notebookCells.push(cell)
  saveNotebook()
  return cell
}

function updateCellCode(cellId, code) {
  const cell = notebookCells.find(c => c.id === cellId)
  if (cell) {
    cell.code = code
    saveNotebook()
  }
  return cell
}

function updateCellOutput(cellId, output) {
  const cell = notebookCells.find(c => c.id === cellId)
  if (cell) {
    cell.output = output
    cell.status = output?.type === 'error' ? 'error' : 'success'
    saveNotebook()
  }
  return cell
}

function setCellStatus(cellId, status) {
  const cell = notebookCells.find(c => c.id === cellId)
  if (cell) {
    cell.status = status
  }
  return cell
}

function removeCell(cellId) {
  notebookCells = notebookCells.filter(c => c.id !== cellId)
  saveNotebook()
}

function clearAllCells() {
  notebookCells = []
  saveNotebook()
}

function getAllCells() {
  return notebookCells
}

function loadNotebook() {
  try {
    const saved = localStorage.getItem(NOTEBOOK_STORAGE_KEY)
    if (saved) {
      const data = JSON.parse(saved)
      notebookCells = data.cells || []
      cellIdCounter = data.counter || notebookCells.length
      // Restore CodeMirror instances for each cell
      return notebookCells
    }
  } catch (e) {
    console.error('Failed to load notebook:', e)
  }
  return []
}

function saveNotebook() {
  try {
    localStorage.setItem(NOTEBOOK_STORAGE_KEY, JSON.stringify({
      cells: notebookCells.map(c => ({
        id: c.id,
        code: c.code,
        output: c.output,
        status: c.status,
        createdAt: c.createdAt
      })),
      counter: cellIdCounter
    }))
  } catch (e) {
    console.error('Failed to save notebook:', e)
  }
}
