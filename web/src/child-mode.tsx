import { createContext, useContext, type ReactNode } from "react";

export interface ChildModeValue {
  child: boolean;
  catalogue: boolean;
}

const ChildModeContext = createContext<ChildModeValue>({ child: false, catalogue: false });

export function ChildModeProvider({ child, catalogue, children }: ChildModeValue & { children: ReactNode }) {
  return <ChildModeContext.Provider value={{ child, catalogue }}>{children}</ChildModeContext.Provider>;
}

export function useChildMode(): ChildModeValue {
  return useContext(ChildModeContext);
}
