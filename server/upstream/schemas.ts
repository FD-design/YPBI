import { z } from "zod";

const looseNumber = z.union([z.number(), z.string(), z.null(), z.undefined()]).transform((value) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
});

export const pDaySumRowSchema = z.object({
  pid: z.string(),
  sumDate: z.string(),
  loginUserCount: looseNumber,
  registerUserCount: looseNumber,
  newUserCount: looseNumber,
  watchUserCount: looseNumber,
  totalChargeUserCount: looseNumber,
  diamondChargeAmt: looseNumber,
  androidLoginUserCount: looseNumber,
  iosLoginUserCount: looseNumber,
  androidNewUserCount: looseNumber,
  iosNewUserCount: looseNumber,
  channelRegisterCount: looseNumber,
  channelInternalRegisterCount: looseNumber,
  totalClickedCount: looseNumber,
  totalClickedPerson: looseNumber,
  newUserTotalClickedCount: looseNumber,
  newUserTotalClickedPerson: looseNumber,
  newUserDiamondChargeAmt: looseNumber,
  newUserChargeUserCount: looseNumber,
  channelNewUserChargeAmt: looseNumber,
  channelInternalNewUserChargeAmt: looseNumber
}).loose();

export const pagedUpstreamResponseSchema = z.object({
  code: z.union([z.number(), z.string()]).optional(),
  msg: z.object({
    pageData: z.array(z.unknown()),
    total: z.union([z.number(), z.string()]).optional()
  }).loose()
}).loose();

export type PDaySumRow = z.infer<typeof pDaySumRowSchema>;

export const eventStatsRowSchema = z.object({
  pid: z.string().optional(),
  reportDate: z.string().optional(),
  appStart: looseNumber.optional(),
  activeUser: looseNumber.optional(),
  registryUser: looseNumber.optional(),
  videoCount: looseNumber.optional(),
  videoClick: looseNumber.optional(),
  videoPlay: looseNumber.optional(),
  videoPlayEnd: looseNumber.optional(),
  like: looseNumber.optional(),
  collect: looseNumber.optional(),
  share: looseNumber.optional(),
  comments: looseNumber.optional(),
  vipClick: looseNumber.optional(),
  prePay: looseNumber.optional(),
  successPay: looseNumber.optional()
}).loose();

export const hotSearchRowSchema = z.object({
  pid: z.string(),
  words: z.string(),
  searchCnt: looseNumber
}).loose();

export const videoRowSchema = z.object({
  pid: z.string(),
  vid: z.string(),
  videoName: z.string().optional(),
  sumDate: z.string().optional(),
  watchedCount: looseNumber.optional(),
  watchedUserCount: looseNumber.optional(),
  likedCount: looseNumber.optional(),
  collectedCount: looseNumber.optional(),
  totalChargeMoney: looseNumber.optional(),
  totalWatchTime: looseNumber.optional(),
  avgWatchTime: looseNumber.optional(),
  categories: z.array(z.string()).optional()
}).loose();

export const videoRankingRowSchema = z.object({
  pid: z.string(),
  _id: z.union([z.string(), z.number()]),
  name: z.string().optional(),
  watchedCount: looseNumber.optional(),
  likedCount: looseNumber.optional(),
  collectedCount: looseNumber.optional(),
  totalChargeMoney: looseNumber.optional(),
  tags: z.array(z.union([z.string(), z.object({ name: z.string().optional() }).loose()])).optional()
}).loose();

export const realtimeRowSchema = z.object({
  sumDate: z.string().optional(),
  graphDate: z.string().optional(),
  newUserCount: looseNumber.optional(),
  registerUserCount: looseNumber.optional(),
  loginUserCount: looseNumber.optional(),
  watchUserCount: looseNumber.optional(),
  totalUserWatchTime: looseNumber.optional(),
  totalChargeAmt: looseNumber.optional(),
  totalChargeUserCount: looseNumber.optional()
}).loose();

export const userDailyRowSchema = z.object({
  pid: z.string(), uid: z.union([z.string(), z.number()]), sumDate: z.string(),
  totalChargeMoney: looseNumber.optional(), totalVipChargeMoney: looseNumber.optional(),
  totalDiamondChargeMoney: looseNumber.optional(), watchedTime: looseNumber.optional(),
  watchedVideoCount: looseNumber.optional(), watchCount: looseNumber.optional(),
  adsCount: looseNumber.optional(), navCount: looseNumber.optional(), buyVipType: z.unknown().optional()
}).loose();

export const circleRowSchema = z.object({
  pid: z.string(), circleId: z.union([z.string(), z.number()]), circleName: z.string().optional(),
  watchedCount: looseNumber.optional(), watchedUserCount: looseNumber.optional(),
  likedCount: looseNumber.optional(), collectedCount: looseNumber.optional(),
  totalChargeMoney: looseNumber.optional(), payType: z.unknown().optional()
}).loose();
