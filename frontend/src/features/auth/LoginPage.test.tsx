import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { installFakeApi } from '@/test/fakeApi';
import { renderWithApp } from '@/test/render';
import LoginPage from './LoginPage';

let api: ReturnType<typeof installFakeApi>;
afterEach(() => api?.restore());
const user = { id: 'u1', email: 'a@b.test', fullName: 'Demo Admin', role: 'admin', isActive: true };

describe('LoginPage', () => {
  it('has labelled fields: each label resolves to the correct input, with the expected type and autocomplete', () => {
    api = installFakeApi({});
    renderWithApp(<LoginPage />);
    const email = screen.getByLabelText('Email'); const password = screen.getByLabelText('Password');
    expect(email).toHaveAttribute('type', 'email');
    expect(email).toHaveAttribute('autocomplete', 'username');
    expect(password).toHaveAttribute('type', 'password');
    expect(password).toHaveAttribute('autocomplete', 'current-password');
    expect(email.id).not.toBe(password.id);
    expect(screen.getByRole('textbox', { name: 'Email' })).toBe(email);        // exposed to assistive technology by its label
  });

  it('behaves as before: submits the typed credentials to POST /auth/login', async () => {
    api = installFakeApi({ 'POST /auth/login': { data: { token: 't', user } } });
    renderWithApp(<LoginPage />);
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.test');
    await userEvent.type(screen.getByLabelText('Password'), 'S3cret-pass');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(api.called('POST', '/auth/login')).toHaveLength(1));
    expect(api.called('POST', '/auth/login')[0]!.body).toEqual({ email: 'a@b.test', password: 'S3cret-pass' });
  });

  it('still validates: empty submit shows the field errors and sends nothing', async () => {
    api = installFakeApi({});
    renderWithApp(<LoginPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
    expect(api.called('POST', '/auth/login')).toHaveLength(0);
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
  });

  it('wrong credentials (401) show the page\'s own "Incorrect email or password." message and keep the form usable', async () => {
    api = installFakeApi({ 'POST /auth/login': { status: 401, error: { code: 'UNAUTHENTICATED', message: 'Invalid email or password' } } });
    renderWithApp(<LoginPage />);
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.test');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong-pass');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Incorrect email or password.')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeEnabled();
  });
});
