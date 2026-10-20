/** The filter box of a toolbar, red while the /regex/ typed in it is not valid. */
export function SearchInput({
  value,
  onChange,
  placeholder,
  invalid,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  invalid?: boolean;
}) {
  return (
    <input
      className={`search${invalid ? ' invalid' : ''}`}
      aria-keyshortcuts="/ Control+F Meta+F"
      aria-label={placeholder}
      placeholder={placeholder}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      spellCheck={false}
    />
  );
}
