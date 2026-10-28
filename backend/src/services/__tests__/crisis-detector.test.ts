import { detectCrisis } from '../crisis-detector';

describe('Crisis Detector', () => {
  // ---- Suicide / Self-Harm Detection ----

  it('detects "I want to kill myself" as emergency', () => {
    const result = detectCrisis('I just want to kill myself');
    expect(result.detected).toBe(true);
    expect(result.severity).toBe('emergency');
    expect(result.categories).toContain('suicide');
    expect(result.resourceMessage).toBeDefined();
  });

  it('detects "I want to die" as emergency', () => {
    const result = detectCrisis('Sometimes I just want to die');
    expect(result.detected).toBe(true);
    expect(result.severity).toBe('emergency');
    expect(result.categories).toContain('suicide');
  });

  it('detects "suicidal" as emergency', () => {
    const result = detectCrisis('I have been feeling suicidal lately');
    expect(result.detected).toBe(true);
    expect(result.severity).toBe('emergency');
    expect(result.categories).toContain('suicide');
  });

  it('detects "end my life" as emergency', () => {
    const result = detectCrisis("I'm thinking about ending my life");
    expect(result.detected).toBe(true);
    expect(result.severity).toBe('emergency');
  });

  it('detects self-harm references as urgent', () => {
    const result = detectCrisis("I've been self-harming again");
    expect(result.detected).toBe(true);
    expect(result.severity).toBe('urgent');
    expect(result.categories).toContain('self-harm');
    expect(result.resourceMessage).toBeDefined();
  });

  // ---- Domestic Violence Detection ----

  it('detects "he hits me" as urgent', () => {
    const result = detectCrisis('He hits me when he gets angry');
    expect(result.detected).toBe(true);
    expect(result.severity).toBe('urgent');
    expect(result.categories).toContain('domestic-violence');
  });

  it('detects "threatening to kill me" as emergency', () => {
    const result = detectCrisis("He's been threatening to kill me");
    expect(result.detected).toBe(true);
    expect(result.severity).toBe('emergency');
    expect(result.categories).toContain('domestic-violence');
  });

  it('detects "physically abused" as urgent', () => {
    const result = detectCrisis('I am being physically abused');
    expect(result.detected).toBe(true);
    expect(result.severity).toBe('urgent');
    expect(result.categories).toContain('domestic-violence');
  });

  // ---- Imminent Danger ----

  it('detects "scared for my life" as emergency', () => {
    const result = detectCrisis("I'm scared for my life right now");
    expect(result.detected).toBe(true);
    expect(result.severity).toBe('emergency');
    expect(result.categories).toContain('imminent-danger');
  });

  it('detects "don\'t feel safe" as urgent', () => {
    const result = detectCrisis("I don't feel safe at home");
    expect(result.detected).toBe(true);
    expect(result.severity).toBe('urgent');
    expect(result.categories).toContain('imminent-danger');
  });

  // ---- Child Abuse ----

  it('detects "hurting my children" as emergency', () => {
    const result = detectCrisis("He's been hurting my children");
    expect(result.detected).toBe(true);
    expect(result.severity).toBe('emergency');
    expect(result.categories).toContain('child-abuse');
  });

  // ---- False Positive Prevention ----

  it('does NOT trigger on "this is killing me" (metaphorical)', () => {
    const result = detectCrisis('This argument is killing me, I need a break');
    expect(result.detected).toBe(false);
    expect(result.severity).toBe('none');
  });

  it('does NOT trigger on normal frustration', () => {
    const result = detectCrisis("I'm really frustrated and angry with my partner");
    expect(result.detected).toBe(false);
    expect(result.severity).toBe('none');
  });

  it('does NOT trigger on "I could kill him" (colloquial)', () => {
    const result = detectCrisis('I could kill him for leaving the dishes again');
    expect(result.detected).toBe(false);
    expect(result.severity).toBe('none');
  });

  it('does NOT trigger on "dying laughing"', () => {
    const result = detectCrisis('I was dying laughing when he said that');
    expect(result.detected).toBe(false);
    expect(result.severity).toBe('none');
  });

  it('does NOT trigger on "hurt feelings"', () => {
    const result = detectCrisis('My feelings are really hurt by what she said');
    expect(result.detected).toBe(false);
    expect(result.severity).toBe('none');
  });

  // ---- Resource Messages ----

  it('includes resource message for emergency severity', () => {
    const result = detectCrisis('I want to kill myself');
    expect(result.resourceMessage).toContain('988');
    expect(result.resourceMessage).toContain('911');
    expect(result.resourceMessage).toContain('Domestic Violence Hotline');
  });

  it('includes resource message for urgent severity', () => {
    const result = detectCrisis('I have been cutting myself');
    expect(result.resourceMessage).toContain('988');
  });

  it('does NOT include resource message for concern severity', () => {
    const result = detectCrisis('I feel unsafe in this relationship');
    expect(result.severity).toBe('concern');
    expect(result.resourceMessage).toBeUndefined();
  });

  it('does NOT include resource message for no detection', () => {
    const result = detectCrisis('We had a disagreement about finances');
    expect(result.resourceMessage).toBeUndefined();
  });

  // ---- Multiple Categories ----

  it('detects multiple categories and returns highest severity', () => {
    const result = detectCrisis("He hits me and I don't want to live anymore");
    expect(result.detected).toBe(true);
    expect(result.severity).toBe('emergency');
    expect(result.categories).toContain('domestic-violence');
    expect(result.categories).toContain('suicide');
  });

  // ---- Case Insensitivity ----

  it('detects patterns regardless of case', () => {
    const result = detectCrisis('I WANT TO KILL MYSELF');
    expect(result.detected).toBe(true);
    expect(result.severity).toBe('emergency');
  });
});
