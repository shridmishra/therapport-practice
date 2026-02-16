import { useState } from 'react';
import { Elements } from '@stripe/react-stripe-js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { StripeCheckout } from './StripeCheckout';
import { stripePromise } from '@/lib/stripe';
import { PRIMARY_COLOR_HEX } from '@/lib/theme';

export interface PaymentModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Stripe PaymentIntent client secret; when set, the form is shown. */
  clientSecret: string | null;
  /** Amount in pence (e.g. 10500 = £105.00) for display. */
  amountPence: number | null;
  onSuccess?: () => void;
  title?: string;
}

/**
 * Modal that hosts Stripe Payment Element to confirm a PaymentIntent.
 * Wrap content in Elements with clientSecret when open; on success or close call callbacks.
 */
export function PaymentModal({
  open,
  onOpenChange,
  clientSecret,
  amountPence,
  onSuccess,
  title,
}: PaymentModalProps) {
  const amountFormatted = amountPence != null ? `£${(amountPence / 100).toFixed(2)}` : null;
  const [isProcessing, setIsProcessing] = useState(false);

  const handleSuccess = () => {
    onOpenChange(false);
    onSuccess?.();
  };

  const handleCancel = () => {
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        onPointerDownOutside={() => {
          if (!isProcessing) onOpenChange(false);
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {title ?? (amountFormatted ? `Pay ${amountFormatted}` : 'Complete payment')}
          </DialogTitle>
          {amountFormatted && (
            <DialogDescription>
              Enter your payment details below to complete the payment.
            </DialogDescription>
          )}
        </DialogHeader>
        {open && clientSecret && stripePromise && (
          <Elements
            stripe={stripePromise}
            options={{
              clientSecret,
              appearance: {
                theme: 'stripe',
                variables: {
                  colorPrimary: PRIMARY_COLOR_HEX,
                },
              },
            }}
          >
            <StripeCheckout
              onSuccess={handleSuccess}
              onCancel={handleCancel}
              onProcessingChange={setIsProcessing}
              submitLabel={amountFormatted ? `Pay ${amountFormatted}` : 'Pay now'}
            />
          </Elements>
        )}
      </DialogContent>
    </Dialog>
  );
}
