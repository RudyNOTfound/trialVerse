import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithApp } from '@/test/render';
import SponsorLayout from './SponsorLayout';

describe('oversight workspace naming', () => {
  it('is labelled "Trial oversight": no visible text implies a sponsor role (routes keep their /sponsor paths)', () => {
    renderWithApp(<SponsorLayout />);
    expect(screen.getAllByText('Trial oversight').length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/sponsor/i);
    expect(screen.getByRole('link', { name: 'Integrity monitoring' })).toHaveAttribute('href', '/sponsor/integrity');
  });
});
