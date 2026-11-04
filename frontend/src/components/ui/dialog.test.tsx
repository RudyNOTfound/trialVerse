import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Dialog, DialogContent } from './dialog';

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open it</button>
      <Dialog open={open} onOpenChange={setOpen}><DialogContent title="Details"><button>Inside</button></DialogContent></Dialog>
    </>
  );
}

describe('DialogContent focus', () => {
  it('moves focus into the dialog, and returns it to the element that opened it (state-driven, no Radix Trigger)', async () => {
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open it' });
    await userEvent.click(opener);
    expect(await screen.findByRole('dialog')).toContainElement(document.activeElement as HTMLElement);
    await userEvent.keyboard('{Escape}');
    await screen.findByRole('button', { name: 'Open it' });
    expect(opener).toHaveFocus();
  });
});
