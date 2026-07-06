export interface Toast {
  id?: string;
  title?: string;
  description?: string;
  variant?: 'default' | 'destructive';
}

export function useToast() {
  const toast = (props: Toast) => {
    const message = props.title || props.description || 'Notificación';
    const isError = props.variant === 'destructive';

    if (typeof window !== 'undefined') {
      if (isError) {
        console.error(message);
      } else {
        console.log(message);
      }
    }
  };

  return { toast };
}
