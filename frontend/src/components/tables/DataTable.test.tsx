import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DataTable } from './DataTable';

const rows = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }];
const cols = [{ header: 'Name', cell: (r: (typeof rows)[number]) => r.name }, // like the real row actions: the button handles its own click and does not let it reach the row
  { header: '', cell: () => <button onClick={(e) => e.stopPropagation()}>Act</button> }];

describe('DataTable keyboard access', () => {
  it('clickable rows are focusable and Enter / Space open them', async () => {
    const onRowClick = vi.fn();
    render(<DataTable rows={rows} rowKey={(r) => r.id} columns={cols} onRowClick={onRowClick} />);
    const row = screen.getByText('Alpha').closest('tr')!;
    expect(row).toHaveAttribute('tabindex', '0');
    row.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    expect(onRowClick).toHaveBeenCalledTimes(2);
    expect(onRowClick).toHaveBeenCalledWith(rows[0]);
  });
  it('a button inside the row keeps its own behaviour: Enter on it does not also open the row', async () => {
    const onRowClick = vi.fn();
    render(<DataTable rows={rows} rowKey={(r) => r.id} columns={cols} onRowClick={onRowClick} />);
    screen.getAllByRole('button', { name: 'Act' })[0]!.focus();
    await userEvent.keyboard('{Enter}');
    expect(onRowClick).not.toHaveBeenCalled();
  });
  it('rows are not focusable when nothing happens on click', () => {
    render(<DataTable rows={rows} rowKey={(r) => r.id} columns={cols} />);
    expect(screen.getByText('Alpha').closest('tr')).not.toHaveAttribute('tabindex');
  });
});
