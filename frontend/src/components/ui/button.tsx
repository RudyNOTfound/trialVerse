import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 select-none',
  {
    variants: {
      variant: {
        primary: 'bg-brand-600 text-white shadow-sm hover:bg-brand-700',
        navy: 'bg-navy-900 text-white shadow-sm hover:bg-navy-800',
        outline: 'border border-line bg-white text-ink hover:bg-slate-50',
        ghost: 'text-slate-600 hover:bg-slate-100 hover:text-ink',
        danger: 'bg-red-600 text-white shadow-sm hover:bg-red-700',
        'danger-outline': 'border border-red-200 bg-white text-red-700 hover:bg-red-50',
      },
      size: { sm: 'h-8 px-3', md: 'h-10 px-4', lg: 'h-11 px-6 text-base', icon: 'h-9 w-9' },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild, loading, disabled, children, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} disabled={disabled || loading} {...props}>
        {asChild ? children : (<>{loading && <Loader2 className="h-4 w-4 animate-spin" />}{children}</>)}
      </Comp>
    );
  },
);
Button.displayName = 'Button';
