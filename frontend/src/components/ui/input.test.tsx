import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Field, Input, Select, Textarea } from './input';

describe('Field label association', () => {
  it('ties each label to its own control: getByLabelText resolves to the right element, for input, select and textarea', () => {
    render(<><Field label="Email"><Input type="email" /></Field><Field label="Role"><Select><option>a</option></Select></Field><Field label="Notes"><Textarea /></Field></>);
    expect(screen.getByLabelText('Email')).toHaveAttribute('type', 'email');
    expect(screen.getByLabelText('Role').tagName).toBe('SELECT');
    expect(screen.getByLabelText('Notes').tagName).toBe('TEXTAREA');
  });
  it('generates unique ids, so two fields never share one', () => {
    render(<><Field label="One"><Input /></Field><Field label="Two"><Input /></Field></>);
    const a = screen.getByLabelText('One').id; const b = screen.getByLabelText('Two').id;
    expect(a).toBeTruthy(); expect(b).toBeTruthy(); expect(a).not.toBe(b);
    expect(screen.getByText('One')).toHaveAttribute('for', a);
  });
  it('keeps an id the control already has (and points the label at it)', () => {
    render(<Field label="Custom"><Input id="my-id" /></Field>);
    expect(screen.getByLabelText('Custom')).toHaveAttribute('id', 'my-id');
  });
  it('clicking the label focuses the field', async () => {
    render(<Field label="Name"><Input /></Field>);
    await userEvent.click(screen.getByText('Name'));
    expect(screen.getByLabelText('Name')).toHaveFocus();
  });
  it('still renders hint and error text, and other control props are untouched', () => {
    render(<Field label="Email" error="Required"><Input type="email" autoComplete="username" placeholder="you@x.org" /></Field>);
    expect(screen.getByRole('alert')).toHaveTextContent('Required');
    expect(screen.getByLabelText('Email')).toHaveAttribute('autocomplete', 'username');
    expect(screen.getByLabelText('Email')).toHaveAttribute('placeholder', 'you@x.org');
  });
});
