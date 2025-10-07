'use client';

import { useEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';

interface ModalProps {
  children: React.ReactNode;
  isOpen: boolean;
}

export function Modal({ children, isOpen }: ModalProps) {
  const [mounted, setMounted] = useState(false);
  const portalRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    portalRef.current = document.body;
    setMounted(true);
    return () => {
      setMounted(false);
    };
  }, []);

  if (!mounted || !isOpen || !portalRef.current) return null;

  return createPortal(
    children,
    portalRef.current
  );
}