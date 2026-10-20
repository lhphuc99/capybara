import type { SerializedValue } from '@capybara-devtools/protocol';
import { isSpecial, preview } from '../format';

/** Rows of what console.table() was given: an array's items or an object's values, by index or key. */
function rowsOf(data: SerializedValue | undefined): Array<[string, SerializedValue]> | undefined {
  if (Array.isArray(data)) return data.map((value, index) => [String(index), value]);
  if (typeof data === 'object' && data !== null && !isSpecial(data)) return Object.entries(data);
  return undefined;
}

function cellOf(row: SerializedValue, column: string): SerializedValue | undefined {
  if (Array.isArray(row)) return row[Number(column)];
  if (typeof row === 'object' && row !== null && !isSpecial(row)) return row[column];
  return undefined;
}

/** The table console.table() prints, with the columns it was given or every key of the rows. */
export function LogTable({ data, columns }: { data: SerializedValue | undefined; columns: SerializedValue | undefined }) {
  const rows = rowsOf(data);
  // Anything else is logged as it is, as browsers do.
  if (!rows) return null;
  const keys = Array.isArray(columns) ? columns.filter((column): column is string => typeof column === 'string') : [];
  let values = false;
  if (keys.length === 0) {
    const seen = new Set<string>();
    for (const [, row] of rows) {
      if (Array.isArray(row)) for (let index = 0; index < row.length; index++) seen.add(String(index));
      else if (typeof row === 'object' && row !== null && !isSpecial(row)) for (const key of Object.keys(row)) seen.add(key);
      else values = true;
    }
    keys.push(...seen);
  }
  const text = (value: SerializedValue | undefined) => (value === undefined ? '' : typeof value === 'string' ? value : preview(value));
  return (
    <div className="log-table-wrap">
      <table className="log-table">
        <thead>
          <tr>
            <th>(index)</th>
            {keys.map((key) => (
              <th key={key}>{key}</th>
            ))}
            {values && <th>Value</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map(([index, row]) => (
            <tr key={index}>
              <td>{index}</td>
              {keys.map((key) => (
                <td key={key}>{text(cellOf(row, key))}</td>
              ))}
              {values && <td>{rowsOf(row) ? '' : text(row)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
