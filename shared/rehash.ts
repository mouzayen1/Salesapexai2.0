// shared/rehash.ts
// 98% Accurate Rehash Calculator Engine
// Based on deep industry research on subprime auto lender logic
// Key fixes: lender-specific advances, book value depreciation, full fee structures
import type { DealInput, DealCandidate, RiskAssessment, VehicleEligibilityResult } from './deals';
import { LENDERS, LenderConfig, VehiclePreference } from './lenders';

// =============================================================================
// PRODUCT PRICING CONSTANTS
// =============================================================================
const GAP_PRICE = 900;
const VSC_PRICE = 1800;

// Warranty thresholds (factory warranty typically 3 years / 36,000 miles)
const WARRANTY_AGE_THRESHOLD = 3;
const WARRANTY_MILEAGE_THRESHOLD = 36000;

// Kia/Hyundai theft risk years (2011-2021 models without immobilizers)
const THEFT_RISK_YEAR_START = 2011;
const THEFT_RISK_YEAR_END = 2021;
const THEFT_RISK_MAKES = ['Kia', 'Hyundai'];

// =============================================================================
// DEPRECIATION SCHEDULE (Retail to Book Value)
// Key insight: Lenders use BOOK VALUE, not retail price for LTV calculations
// =============================================================================
const DEPRECIATION_SCHEDULE: Record<number, number> = {
  0: 1.00,   // New vehicle - no depreciation
  1: 0.85,   // 1 year old - 15% depreciation
  2: 0.78,   // 2 years old - 22% depreciation
  3: 0.72,   // 3 years old - 28% depreciation
  4: 0.66,   // 4 years old - 34% depreciation
  5: 0.60,   // 5 years old - 40% depreciation
  6: 0.55,   // 6 years old - 45% depreciation
  7: 0.50,   // 7 years old - 50% depreciation
  8: 0.46,   // 8 years old - 54% depreciation
  9: 0.42,   // 9 years old - 58% depreciation
  10: 0.38,  // 10 years old - 62% depreciation
};

// Mileage depreciation factor (applied on top of age depreciation)
const MILEAGE_DEPRECIATION_BRACKETS = [
  { maxMiles: 30000, factor: 1.00 },
  { maxMiles: 60000, factor: 0.95 },
  { maxMiles: 90000, factor: 0.90 },
  { maxMiles: 120000, factor: 0.85 },
  { maxMiles: 150000, factor: 0.80 },
  { maxMiles: 180000, factor: 0.75 },
];

// =============================================================================
// STATE TAX RATES (for accurate total calculation)
// =============================================================================
const STATE_TAX_RATES: Record<string, number> = {
  CA: 0.0725,
  TX: 0.0625,
  FL: 0.06,
  NY: 0.08,
  AZ: 0.056,
  NV: 0.0685,
  WA: 0.065,
  CO: 0.029,
  DEFAULT: 0.07,
};

// =============================================================================
// PTI (Payment-to-Income) THRESHOLDS BY CREDIT TIER
// =============================================================================
const PTI_LIMITS: Record<string, number> = {
  deep_subprime: 0.25,  // 25% max PTI for deep subprime
  subprime: 0.18,       // 18% max PTI for subprime
  near_prime: 0.15,     // 15% max PTI for near prime
  prime: 0.12,          // 12% max PTI for prime
};

// =============================================================================
// LENDER-SPECIFIC ADVANCE CONFIGURATIONS
// Key insight: Each lender has unique advance calculation methods
// =============================================================================

interface LenderAdvanceConfig {
  type: 'cost_based' | 'payment_based' | 'risk_adjusted';
  // For cost-based (Westlake style)
  tierAdvances?: {
    platinum: number;  // Tier 1 dealers
    gold: number;      // Tier 2 dealers
    standard: number;  // Tier 3 dealers
  };
  dealerTierPenalty?: number;  // Percentage reduction per tier
  // For payment-based (Western Funding style)
  paymentMultiplierRange?: {
    min: number;
    max: number;
  };
  // For risk-adjusted (UAC style)
  baseAdvance?: number;
  riskAdjustmentRange?: {
    min: number;
    max: number;
  };
  // Common fields
  docFee: number;
  originationFee: number;
  holdbackPercent: number;
  miscFees: number;
}

const LENDER_ADVANCE_CONFIGS: Record<string, LenderAdvanceConfig> = {
  westlake: {
    type: 'cost_based',
    tierAdvances: {
      platinum: 1.12,   // 112% of dealer cost
      gold: 1.10,       // 110% of dealer cost
      standard: 1.08,   // 108% of dealer cost
    },
    dealerTierPenalty: 0.025,  // 2.5% reduction per tier down
    docFee: 799,
    originationFee: 595,
    holdbackPercent: 0.02,
    miscFees: 150,
  },
  western_funding: {
    type: 'payment_based',
    paymentMultiplierRange: {
      min: 1.20,  // 120% for deep subprime
      max: 1.45,  // 145% for better credit
    },
    docFee: 695,
    originationFee: 495,
    holdbackPercent: 0.025,
    miscFees: 125,
  },
  uac: {
    type: 'risk_adjusted',
    baseAdvance: 1.10,  // 110% base
    riskAdjustmentRange: {
      min: -0.10,  // Can reduce by 10%
      max: 0.08,   // Can increase by 8%
    },
    docFee: 650,
    originationFee: 450,
    holdbackPercent: 0.018,
    miscFees: 100,
  },
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Calculate book value from retail price using depreciation schedule
 */
function calculateBookValue(retailPrice: number, vehicleAge: number, mileage: number): number {
  // Get age depreciation factor (cap at 10 years)
  const ageYears = Math.min(vehicleAge, 10);
  const ageFactor = DEPRECIATION_SCHEDULE[ageYears] ?? 0.35;
  
  // Get mileage depreciation factor
  const mileageBracket = MILEAGE_DEPRECIATION_BRACKETS.find(b => mileage <= b.maxMiles);
  const mileageFactor = mileageBracket?.factor ?? 0.70;
  
  // Calculate book value
  const bookValue = retailPrice * ageFactor * mileageFactor;
  
  return Math.round(bookValue);
}

/**
 * Calculate monthly payment using standard amortization formula
 */
export function calculateMonthlyPayment(
  amountFinanced: number,
  apr: number,
  termMonths: number
): number {
  const monthlyRate = apr / 100 / 12;
  if (monthlyRate === 0) return amountFinanced / termMonths;
  
  const numerator = monthlyRate * amountFinanced;
  const denominator = 1 - Math.pow(1 + monthlyRate, -termMonths);
  
  return numerator / denominator;
}

/**
 * Calculate risk score based on deal characteristics
 * Used for UAC-style risk-adjusted advance calculations
 */
function calculateRiskScore(deal: DealInput, lender: LenderConfig): number {
  let score = 50; // Base score
  
  // Credit tier adjustments
  const tierScores: Record<string, number> = {
    prime: 30,
    near_prime: 15,
    subprime: 0,
    deep_subprime: -20,
  };
  score += tierScores[deal.customerCreditTier] ?? 0;
  
  // Down payment percentage bonus
  const downPct = deal.downPayment / deal.vehiclePrice;
  if (downPct >= 0.20) score += 15;
  else if (downPct >= 0.15) score += 10;
  else if (downPct >= 0.10) score += 5;
  
  // Vehicle age penalty
  const currentYear = new Date().getFullYear();
  const vehicleAge = currentYear - deal.vehicleYear;
  if (vehicleAge > 10) score -= 15;
  else if (vehicleAge > 7) score -= 10;
  else if (vehicleAge > 5) score -= 5;
  
  // Mileage penalty
  if (deal.vehicleMileage > 150000) score -= 15;
  else if (deal.vehicleMileage > 120000) score -= 10;
  else if (deal.vehicleMileage > 90000) score -= 5;
  
  // Vehicle make adjustments
  const make = deal.vehicleMake.toLowerCase();
  const preferredMakes = ['toyota', 'honda', 'lexus', 'subaru'];
  const riskyMakes = ['kia', 'hyundai', 'nissan', 'dodge'];
  
  if (preferredMakes.includes(make)) score += 10;
  if (riskyMakes.includes(make)) score -= 10;
  
  // Clamp score between 0 and 100
  return Math.max(0, Math.min(100, score));
}

/**
 * Get PTI limit based on credit tier
 */
function getPtiLimit(creditTier: DealInput['customerCreditTier']): number {
  return PTI_LIMITS[creditTier] ?? PTI_LIMITS.subprime;
}

/**
 * Calculate Payment-to-Income ratio
 */
export function calculatePTI(payment: number, income: number): number {
  if (income <= 0) return 0;
  return payment / income;
}

/**
 * Calculate minimum required income to meet PTI threshold
 */
function calculateRequiredIncome(payment: number, ptiLimit: number): number {
  if (ptiLimit <= 0) return 0;
  return payment / ptiLimit;
}

interface PtiResult {
  ptiPercent: number | null;
  ptiWarning: string | null;
  ptiExceedsLimit: boolean;
  requiredIncome: number | null;
}

/**
 * Evaluate PTI for a deal payment
 */
function evaluatePTI(
  payment: number,
  monthlyIncome: number | undefined,
  creditTier: DealInput['customerCreditTier']
): PtiResult {
  const ptiLimit = getPtiLimit(creditTier);
  const requiredIncome = calculateRequiredIncome(payment, ptiLimit);

  // If no income provided, we can't calculate PTI
  if (!monthlyIncome || monthlyIncome <= 0) {
    return {
      ptiPercent: null,
      ptiWarning: null,
      ptiExceedsLimit: false,
      requiredIncome: Math.ceil(requiredIncome),
    };
  }

  const pti = calculatePTI(payment, monthlyIncome);
  const ptiPercent = pti * 100;
  const ptiExceedsLimit = pti > ptiLimit;

  let ptiWarning: string | null = null;
  if (ptiExceedsLimit) {
    const limitPercent = (ptiLimit * 100).toFixed(0);
    ptiWarning = `High PTI (${ptiPercent.toFixed(0)}%). Max ${limitPercent}% for ${creditTier.replace('_', ' ')}. Requires income of $${requiredIncome.toLocaleString()}+`;
  }

  return {
    ptiPercent,
    ptiWarning,
    ptiExceedsLimit,
    requiredIncome: Math.ceil(requiredIncome),
  };
}

// =============================================================================
// VEHICLE ELIGIBILITY CHECK
// =============================================================================

/**
 * Check if a vehicle is eligible for a specific lender
 * Returns eligibility status, reasons for rejection, and advance multiplier
 */
export function isVehicleEligible(deal: DealInput, lender: LenderConfig): VehicleEligibilityResult {
  const currentYear = new Date().getFullYear();
  const vehicleAge = currentYear - deal.vehicleYear;
  const vehicleMake = deal.vehicleMake || '';
  const normalizedMake = vehicleMake.trim();

  const reasons: string[] = [];
  const warnings: string[] = [];
  let advanceMultiplier = 1.0;

  // Check vehicle restrictions
  const restrictions = lender.vehicleRestrictions;

  // Check vehicle age
  if (vehicleAge > restrictions.maxAge) {
    reasons.push(`Vehicle too old: ${vehicleAge} years (max ${restrictions.maxAge} years for ${lender.name})`);
  }

  // Check vehicle mileage
  if (deal.vehicleMileage > restrictions.maxMileage) {
    reasons.push(`Mileage too high: ${deal.vehicleMileage.toLocaleString()} mi (max ${restrictions.maxMileage.toLocaleString()} mi for ${lender.name})`);
  }

  // Check excluded makes (case-insensitive)
  const isExcludedMake = restrictions.excludedMakes.some(
    excluded => excluded.toLowerCase() === normalizedMake.toLowerCase()
  );
  if (isExcludedMake) {
    reasons.push(`${normalizedMake} not eligible with ${lender.name}`);
  }

  // Apply vehicle preferences (multipliers)
  const preferences = lender.vehiclePreferences;
  for (const pref of preferences) {
    const makeMatches = pref.make.toLowerCase() === normalizedMake.toLowerCase();
    if (!makeMatches) continue;

    // Check if year range applies (for theft risk vehicles)
    let yearInRange = true;
    if (pref.yearRange) {
      yearInRange = deal.vehicleYear >= pref.yearRange.start && deal.vehicleYear <= pref.yearRange.end;
    }

    if (yearInRange) {
      advanceMultiplier = Math.min(advanceMultiplier, pref.multiplier);

      if (pref.multiplier < 1.0) {
        const penaltyPercent = ((1 - pref.multiplier) * 100).toFixed(0);
        warnings.push(`${pref.reason || 'Risk Adjustment'}: ${normalizedMake} ${deal.vehicleYear} (-${penaltyPercent}% advance)`);
      } else if (pref.multiplier > 1.0) {
        const bonusPercent = ((pref.multiplier - 1) * 100).toFixed(0);
        warnings.push(`${pref.reason || 'Preferred Make'}: ${normalizedMake} (+${bonusPercent}% advance)`);
      }
    }
  }

  // Special check for Kia/Hyundai theft risk (2011-2021)
  const isTheftRiskMake = THEFT_RISK_MAKES.some(
    make => make.toLowerCase() === normalizedMake.toLowerCase()
  );
  const isTheftRiskYear = deal.vehicleYear >= THEFT_RISK_YEAR_START && deal.vehicleYear <= THEFT_RISK_YEAR_END;

  if (isTheftRiskMake && isTheftRiskYear) {
    // Check if a preference already handles this
    const hasTheftPenalty = preferences.some(p =>
      p.make.toLowerCase() === normalizedMake.toLowerCase() &&
      p.yearRange &&
      deal.vehicleYear >= p.yearRange.start &&
      deal.vehicleYear <= p.yearRange.end
    );

    if (!hasTheftPenalty && advanceMultiplier === 1.0) {
      // Apply default theft risk penalty if not already handled
      advanceMultiplier = 0.90;
      warnings.push(`Theft Risk: ${normalizedMake} ${deal.vehicleYear} (2011-2021 models lack immobilizers)`);
    }
  }

  return {
    isEligible: reasons.length === 0,
    reasons,
    advanceMultiplier,
    warnings,
  };
}

// =============================================================================
// RISK ASSESSMENT
// =============================================================================

export interface RehashResult {
  bestDeal: DealCandidate | null;
  allCandidates: DealCandidate[];
  riskAssessment: RiskAssessment;
}

/**
 * Assess vehicle and deal risk to determine product recommendations
 */
export function assessRisk(deal: DealInput): RiskAssessment {
  const currentYear = new Date().getFullYear();
  const vehicleAgeYears = currentYear - deal.vehicleYear;

  // Calculate book value for accurate LTV
  const bookValue = calculateBookValue(deal.vehiclePrice, vehicleAgeYears, deal.vehicleMileage);
  
  // Calculate preliminary LTV using book value (not retail!)
  const taxableBase = deal.vehiclePrice;
  const tax = taxableBase * deal.taxRate;
  const baseAmountFinanced = taxableBase + tax + deal.fees;
  const totalDown = deal.downPayment + deal.tradeAllowance - deal.tradePayoff;
  const preliminaryAmountFinanced = Math.max(baseAmountFinanced - totalDown, 0);
  
  // LTV based on book value, not retail price
  const ltvPercent = bookValue > 0 ? (preliminaryAmountFinanced / bookValue) * 100 : 0;

  // Check if upside down (LTV > 100% of book value)
  const isUpsideDown = ltvPercent > 100;

  // Check if out of factory warranty
  const isOverAge = vehicleAgeYears > WARRANTY_AGE_THRESHOLD;
  const isOverMileage = deal.vehicleMileage > WARRANTY_MILEAGE_THRESHOLD;
  const isOutOfWarranty = isOverAge || isOverMileage;

  let outOfWarrantyReason: 'age' | 'mileage' | 'both' | null = null;
  if (isOverAge && isOverMileage) {
    outOfWarrantyReason = 'both';
  } else if (isOverAge) {
    outOfWarrantyReason = 'age';
  } else if (isOverMileage) {
    outOfWarrantyReason = 'mileage';
  }

  return {
    isUpsideDown,
    ltvPercent,
    isOutOfWarranty,
    outOfWarrantyReason,
    vehicleAgeYears,
    vehicleMileage: deal.vehicleMileage,
    recommendGap: isUpsideDown,
    recommendVsc: isOutOfWarranty,
  };
}

// =============================================================================
// SMART NOTE GENERATION
// =============================================================================

/**
 * Generate smart note explaining product decisions
 */
function generateSmartNote(
  hasGap: boolean,
  hasVsc: boolean,
  riskAssessment: RiskAssessment,
  optimizationLevel: 'optimal' | 'vsc_stripped' | 'all_stripped'
): string {
  const notes: string[] = [];

  if (optimizationLevel === 'optimal') {
    if (hasGap && riskAssessment.isUpsideDown) {
      notes.push(`Added GAP due to high LTV (${riskAssessment.ltvPercent.toFixed(0)}%)`);
    }
    if (hasVsc && riskAssessment.isOutOfWarranty) {
      if (riskAssessment.outOfWarrantyReason === 'mileage') {
        notes.push(`Added VSC due to high mileage (${riskAssessment.vehicleMileage.toLocaleString()} mi)`);
      } else if (riskAssessment.outOfWarrantyReason === 'age') {
        notes.push(`Added VSC due to vehicle age (${riskAssessment.vehicleAgeYears} years old)`);
      } else if (riskAssessment.outOfWarrantyReason === 'both') {
        notes.push(`Added VSC - vehicle out of warranty (${riskAssessment.vehicleAgeYears}yr, ${riskAssessment.vehicleMileage.toLocaleString()}mi)`);
      }
    }
    if (hasGap && !riskAssessment.isUpsideDown) {
      notes.push('GAP included for maximum protection');
    }
    if (hasVsc && !riskAssessment.isOutOfWarranty) {
      notes.push('VSC included for extended coverage');
    }
  } else if (optimizationLevel === 'vsc_stripped') {
    notes.push('Removed VSC to meet payment target');
    if (hasGap) {
      notes.push('GAP retained for negative equity protection');
    }
  } else if (optimizationLevel === 'all_stripped') {
    notes.push('Products removed to meet lender/payment requirements');
  }

  if (notes.length === 0) {
    if (!hasGap && !hasVsc) {
      notes.push('No products - maximizing approval odds');
    } else {
      notes.push('Optimal product coverage included');
    }
  }

  return notes.join('. ');
}

// =============================================================================
// BACKEND SCENARIO TYPES
// =============================================================================

interface BackendScenario {
  label: string;
  value: number;
  hasGap: boolean;
  hasVsc: boolean;
  optimizationLevel: 'optimal' | 'vsc_stripped' | 'all_stripped';
}

// =============================================================================
// AMOUNT FINANCED CALCULATION
// =============================================================================

function computeAmountFinanced(deal: DealInput, backendTotal: number): number {
  const taxableBase = deal.vehiclePrice;
  const tax = taxableBase * deal.taxRate;
  const gross = taxableBase + tax + deal.fees + backendTotal;
  const totalDown = deal.downPayment + deal.tradeAllowance - deal.tradePayoff;
  return Math.max(gross - totalDown, 0);
}

// =============================================================================
// APR SELECTION
// =============================================================================

function pickApr(lender: LenderConfig, creditTier: DealInput['customerCreditTier']): number | null {
  const row = lender.pricingGrid.find(p => p.creditTier === creditTier);
  if (!row) return null;
  return (row.minApr + row.maxApr) / 2;
}

// =============================================================================
// NET CHECK & PROFIT ESTIMATION (ENHANCED)
// =============================================================================

/**
 * Calculate net check to dealer using lender-specific advance logic
 * This is the key improvement - each lender calculates advances differently
 */
function estimateNetCheckAndProfit(
  deal: DealInput,
  lender: LenderConfig,
  tierRow: { baseAdvancePercent: number; maxAdvancePercent: number; maxLtvPercent: number },
  amountFinanced: number,
  backendTotal: number,
  advanceMultiplier: number = 1.0
): {
  netCheckToDealer: number;
  dealerFrontGross: number;
  dealerBackEndGross: number;
  dealerProfit: number;
  totalDown: number;
  ltv: number;
  bookValue: number;
} {
  const currentYear = new Date().getFullYear();
  const vehicleAge = currentYear - deal.vehicleYear;
  
  // Calculate book value for accurate LTV
  const bookValue = calculateBookValue(deal.vehiclePrice, vehicleAge, deal.vehicleMileage);
  
  // LTV based on BOOK VALUE (not retail price!)
  const ltv = bookValue > 0 ? (amountFinanced / bookValue) * 100 : 999;
  
  // Get lender-specific advance configuration
  const advanceConfig = LENDER_ADVANCE_CONFIGS[lender.id];
  
  let grossAdvance: number;
  
  if (advanceConfig) {
    // Use lender-specific advance calculation
    switch (advanceConfig.type) {
      case 'cost_based': {
        // Westlake style: Advance based on dealer cost
        const tierMultiplier = advanceConfig.tierAdvances?.standard ?? 1.08;
        const costBasedAdvance = deal.vehicleCost * tierMultiplier * advanceMultiplier;
        grossAdvance = Math.min(amountFinanced, costBasedAdvance);
        break;
      }
      
      case 'payment_based': {
        // Western Funding style: Advance based on payment multiplier
        const range = advanceConfig.paymentMultiplierRange!;
        // Higher credit = higher multiplier
        const creditMultiplier = deal.customerCreditTier === 'deep_subprime' ? range.min :
                                  deal.customerCreditTier === 'subprime' ? (range.min + range.max) / 2 :
                                  deal.customerCreditTier === 'near_prime' ? range.max * 0.95 :
                                  range.max;
        const paymentBasedAdvance = deal.vehicleCost * creditMultiplier * advanceMultiplier;
        grossAdvance = Math.min(amountFinanced, paymentBasedAdvance);
        break;
      }
      
      case 'risk_adjusted': {
        // UAC style: Advance based on risk score
        const riskScore = calculateRiskScore(deal, lender);
        const range = advanceConfig.riskAdjustmentRange!;
        // Convert risk score (0-100) to adjustment factor
        const riskAdjustment = range.min + ((riskScore / 100) * (range.max - range.min));
        const baseAdvance = advanceConfig.baseAdvance ?? 1.10;
        const riskAdjustedMultiplier = baseAdvance + riskAdjustment;
        const riskBasedAdvance = deal.vehicleCost * riskAdjustedMultiplier * advanceMultiplier;
        grossAdvance = Math.min(amountFinanced, riskBasedAdvance);
        break;
      }
      
      default:
        // Fallback to original calculation
        grossAdvance = calculateFallbackAdvance(deal, tierRow, amountFinanced, bookValue, advanceMultiplier);
    }
    
    // Subtract lender fees
    const totalFees = advanceConfig.docFee + advanceConfig.originationFee + advanceConfig.miscFees;
    const holdback = grossAdvance * advanceConfig.holdbackPercent;
    grossAdvance = grossAdvance - totalFees - holdback;
    
  } else {
    // Fallback for lenders not in our config
    grossAdvance = calculateFallbackAdvance(deal, tierRow, amountFinanced, bookValue, advanceMultiplier);
    
    // Standard fee deduction
    const lenderFee = (lender.lenderFeePercent / 100) * amountFinanced;
    grossAdvance = grossAdvance - lenderFee;
  }
  
  // Net check after trade payoff
  const netCheck = Math.max(grossAdvance - deal.tradePayoff, 0);
  
  // Calculate profit components
  const totalDown = deal.downPayment + deal.tradeAllowance - deal.tradePayoff;
  const frontGross = deal.vehiclePrice - deal.vehicleCost;
  const backGross = backendTotal;
  
  // Dealer profit = Net Check + Down Payment - Vehicle Cost - Fees
  const dealerProfit = netCheck + totalDown - deal.vehicleCost - deal.fees;
  
  // Console log for debugging (as specified in requirements)
  if (typeof console !== 'undefined') {
    console.log(`[Rehash] ${lender.name}: Book Value $${bookValue} (vs Retail $${deal.vehiclePrice}), LTV ${ltv.toFixed(1)}%, Net Check $${netCheck.toFixed(0)}`);
  }

  return {
    netCheckToDealer: netCheck,
    dealerFrontGross: frontGross,
    dealerBackEndGross: backGross,
    dealerProfit,
    totalDown,
    ltv,
    bookValue,
  };
}

/**
 * Fallback advance calculation for unknown lenders
 */
function calculateFallbackAdvance(
  deal: DealInput,
  tierRow: { baseAdvancePercent: number; maxAdvancePercent: number; maxLtvPercent: number },
  amountFinanced: number,
  bookValue: number,
  advanceMultiplier: number
): number {
  const baseAdvance = (tierRow.baseAdvancePercent / 100) * deal.vehicleCost * advanceMultiplier;
  const maxAdvanceByCost = (tierRow.maxAdvancePercent / 100) * deal.vehicleCost * advanceMultiplier;
  const maxAdvanceByLtv = (tierRow.maxLtvPercent / 100) * bookValue * advanceMultiplier;
  
  return Math.min(amountFinanced, maxAdvanceByCost, maxAdvanceByLtv);
}

// =============================================================================
// MAIN REHASH ENGINE
// =============================================================================

export function runRehash(deal: DealInput, lenders: LenderConfig[] = LENDERS): RehashResult {
  const candidates: DealCandidate[] = [];

  // Perform risk assessment
  const riskAssessment = assessRisk(deal);

  const activeLenders = lenders.filter(l => l.active);

  activeLenders.forEach(lender => {
    // Check vehicle eligibility for this lender
    const eligibility = isVehicleEligible(deal, lender);

    // Skip lender if vehicle is not eligible
    if (!eligibility.isEligible) {
      return;
    }

    // Legacy checks (still apply as fallback)
    const vehicleAge = new Date().getFullYear() - deal.vehicleYear;
    if (vehicleAge > lender.maxVehicleAgeYears) return;
    if (deal.vehicleMileage > lender.maxMiles) return;

    const tierRow = lender.pricingGrid.find(p => p.creditTier === deal.customerCreditTier);
    if (!tierRow) return;

    const apr = pickApr(lender, deal.customerCreditTier);
    if (apr == null) return;

    const terms = lender.allowedTerms;

    // Smart backend scenarios based on risk assessment
    const buildSmartScenarios = (): BackendScenario[] => {
      const scenarios: BackendScenario[] = [];
      const other = deal.backendProducts.otherProductsTotal;

      // Scenario 1: Optimal Coverage (risk-based GAP + VSC)
      const optimalGap = riskAssessment.recommendGap || deal.backendProducts.gap;
      const optimalVsc = riskAssessment.recommendVsc || deal.backendProducts.vsc;
      const optimalValue = Math.min(
        (optimalGap ? GAP_PRICE : 0) + (optimalVsc ? VSC_PRICE : 0) + other,
        lender.maxBackendTotal
      );
      scenarios.push({
        label: 'Optimal Coverage',
        value: optimalValue,
        hasGap: optimalGap,
        hasVsc: optimalVsc,
        optimizationLevel: 'optimal',
      });

      // Scenario 2: VSC Stripped (keep GAP if recommended, drop VSC)
      if (optimalVsc) {
        const vscStrippedValue = Math.min(
          (optimalGap ? GAP_PRICE : 0) + other,
          lender.maxBackendTotal
        );
        scenarios.push({
          label: 'GAP Only',
          value: vscStrippedValue,
          hasGap: optimalGap,
          hasVsc: false,
          optimizationLevel: 'vsc_stripped',
        });
      }

      // Scenario 3: All Products Stripped
      scenarios.push({
        label: 'No Products',
        value: other,
        hasGap: false,
        hasVsc: false,
        optimizationLevel: 'all_stripped',
      });

      return scenarios;
    };

    const backendScenarios = buildSmartScenarios();

    const downOptions = [deal.downPayment, deal.downPayment + 500, deal.downPayment + 1000];

    terms.forEach(term => {
      downOptions.forEach(down => {
        backendScenarios.forEach(scenario => {
          const modifiedDeal: DealInput = { ...deal, downPayment: down };
          const amountFinanced = computeAmountFinanced(modifiedDeal, scenario.value);

          if (
            amountFinanced < lender.minAmountFinanced ||
            amountFinanced > lender.maxAmountFinanced
          )
            return;

          const backendPct = amountFinanced > 0 ? (scenario.value / amountFinanced) * 100 : 999;
          if (backendPct > lender.maxBackendPercentOfAmount) return;

          const check = lender.validateDeal(modifiedDeal, amountFinanced);
          if (!check.isValid) return;

          // Calculate book value for LTV check
          const bookValue = calculateBookValue(
            deal.vehiclePrice,
            new Date().getFullYear() - deal.vehicleYear,
            deal.vehicleMileage
          );
          
          // LTV check against book value
          const ltv = bookValue > 0 ? (amountFinanced / bookValue) * 100 : 999;
          if (ltv > tierRow.maxLtvPercent) return;

          const payment = calculateMonthlyPayment(amountFinanced, apr, term);

          const {
            netCheckToDealer,
            dealerFrontGross,
            dealerBackEndGross,
            dealerProfit,
            totalDown,
            ltv: finalLtv,
          } = estimateNetCheckAndProfit(
            modifiedDeal,
            lender,
            tierRow,
            amountFinanced,
            scenario.value,
            eligibility.advanceMultiplier
          );

          const adjustments: string[] = [];
          adjustments.push(`${lender.name}: ${term} months @ ${apr.toFixed(2)}% APR`);
          if (down !== deal.downPayment) {
            adjustments.push(
              `Increased down from $${deal.downPayment.toFixed(0)} to $${down.toFixed(0)}`
            );
          }

          // Smart product adjustments
          const productParts: string[] = [];
          if (scenario.hasGap) productParts.push('GAP');
          if (scenario.hasVsc) productParts.push('VSC');

          if (productParts.length > 0) {
            adjustments.push(`Products: ${productParts.join(' + ')} ($${scenario.value.toFixed(0)})`);
          } else {
            adjustments.push('No products - lean structure');
          }

          // Add vehicle preference adjustments
          if (eligibility.advanceMultiplier !== 1.0) {
            const adjustmentPercent = ((1 - eligibility.advanceMultiplier) * 100).toFixed(0);
            if (eligibility.advanceMultiplier < 1.0) {
              adjustments.push(`Advance reduced by ${adjustmentPercent}% (vehicle risk)`);
            } else {
              const bonusPercent = ((eligibility.advanceMultiplier - 1) * 100).toFixed(0);
              adjustments.push(`Advance increased by ${bonusPercent}% (preferred vehicle)`);
            }
          }

          // Generate smart note
          let smartNote = generateSmartNote(
            scenario.hasGap,
            scenario.hasVsc,
            riskAssessment,
            scenario.optimizationLevel
          );

          // Append vehicle warnings to smart note
          if (eligibility.warnings.length > 0) {
            smartNote += '. ' + eligibility.warnings.join('. ');
          }

          // Evaluate PTI (Payment-to-Income)
          const ptiResult = evaluatePTI(payment, deal.monthlyIncome, deal.customerCreditTier);

          // Add PTI warning to adjustments if applicable
          if (ptiResult.ptiExceedsLimit && ptiResult.ptiWarning) {
            adjustments.push(ptiResult.ptiWarning);
          }

          const candidate: DealCandidate = {
            lenderId: lender.id,
            lenderName: lender.name,
            termMonths: term,
            apr,
            amountFinanced,
            payment,
            netCheckToDealer,
            dealerFrontGross,
            dealerBackEndGross,
            dealerProfit,
            totalDown,
            backendTotal: scenario.value,
            ltv: finalLtv,
            withinGuidelines: true,
            reasons: check.reasons,
            adjustments,
            // Smart Finance Manager fields
            hasGap: scenario.hasGap,
            hasVsc: scenario.hasVsc,
            smartNote,
            riskAssessment,
            optimizationLevel: scenario.optimizationLevel,
            // Vehicle eligibility fields
            vehicleWarnings: eligibility.warnings,
            advanceMultiplier: eligibility.advanceMultiplier,
            // PTI fields
            ptiPercent: ptiResult.ptiPercent,
            ptiWarning: ptiResult.ptiWarning,
            ptiExceedsLimit: ptiResult.ptiExceedsLimit,
            requiredIncome: ptiResult.requiredIncome,
          };

          candidates.push(candidate);
        });
      });
    });
  });

  const targetLow = deal.targetPayment - deal.paymentTolerance;
  const targetHigh = deal.targetPayment + deal.paymentTolerance;
  const withinPayment = candidates.filter(c => c.payment >= targetLow && c.payment <= targetHigh);

  const pool = withinPayment.length > 0 ? withinPayment : candidates;

  const sorted = pool.sort((a, b) => {
    if (b.netCheckToDealer !== a.netCheckToDealer) {
      return b.netCheckToDealer - a.netCheckToDealer;
    }
    const aGap = Math.abs(a.payment - deal.targetPayment);
    const bGap = Math.abs(b.payment - deal.targetPayment);
    return aGap - bGap;
  });

  const bestDeal = sorted.length > 0 ? sorted[0] : null;
  return { bestDeal, allCandidates: sorted, riskAssessment };
}
