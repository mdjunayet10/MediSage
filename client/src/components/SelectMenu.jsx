import { Check, ChevronDown } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useId, useRef, useState } from "react";

export default function SelectMenu({
  value,
  options,
  onChange,
  ariaLabel,
  icon: Icon,
  disabled = false,
}) {
  const menuId = useId();
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const optionRefs = useRef([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 230 });
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const selected = options[selectedIndex] || options[0];

  function close({ restoreFocus = false } = {}) {
    setOpen(false);
    if (restoreFocus) window.setTimeout(() => triggerRef.current?.focus(), 0);
  }

  function openMenu() {
    if (disabled) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const width = Math.max(230, rect.width);
      const left = Math.min(
        Math.max(8, rect.left),
        window.innerWidth - width - 8,
      );
      setPosition({ left, top: Math.max(8, rect.top - 8), width });
    }
    setActiveIndex(selectedIndex);
    setOpen(true);
  }

  function choose(index) {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    close({ restoreFocus: true });
  }

  function handleKeyDown(event) {
    if (!open && ["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
      event.preventDefault();
      openMenu();
      return;
    }
    if (!open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close({ restoreFocus: true });
      return;
    }
    if (event.key === "Tab") {
      close();
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(activeIndex);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(options.length - 1);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex(
        (index) => (index + delta + options.length) % options.length,
      );
    }
  }

  useEffect(() => {
    if (!open) return undefined;
    optionRefs.current[activeIndex]?.focus();
    return undefined;
  }, [activeIndex, open]);

  useEffect(() => {
    if (!open) return undefined;
    function outside(event) {
      if (
        !triggerRef.current?.contains(event.target) &&
        !menuRef.current?.contains(event.target)
      )
        close();
    }
    function dismiss() {
      close();
    }
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="select-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        title={ariaLabel}
        disabled={disabled}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={handleKeyDown}
      >
        {Icon && <Icon size={15} />}
        <span>{selected.label}</span>
        <ChevronDown size={12} />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="listbox"
            aria-label={ariaLabel}
            className="select-menu"
            style={{
              left: position.left,
              bottom: Math.max(8, window.innerHeight - position.top),
              width: position.width,
            }}
            onKeyDown={handleKeyDown}
          >
            {options.map((option, index) => (
              <button
                ref={(node) => {
                  optionRefs.current[index] = node;
                }}
                type="button"
                role="option"
                aria-selected={option.value === value}
                tabIndex={index === activeIndex ? 0 : -1}
                key={option.value}
                className={`select-option ${index === activeIndex ? "select-option-active" : ""}`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(index)}
              >
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
                {option.value === value && <Check size={15} />}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
