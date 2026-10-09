import type { ComponentProps } from "react";
import { ConnectedCategoryDimension, type ConnectedCategorySource } from "./ConnectedCategoryDimension";
import { demoUnit } from "./extended-board-model";
import { playbackDiagnosisRows, playbackDiagnosisSheet, playbackDiagnosisSupported } from "./playback-diagnosis-model";

const source: ConnectedCategorySource = { rows: playbackDiagnosisRows, sheet: playbackDiagnosisSheet, supported: playbackDiagnosisSupported,
  unit: (_live, id) => demoUnit(id), guidanceKey: "playback.diagnosis", inlineInputs: true };

export function ConnectedPlaybackDiagnosis(props: Omit<ComponentProps<typeof ConnectedCategoryDimension>, "source" | "renderSelect">) {
  return <ConnectedCategoryDimension {...props} source={source} />;
}
