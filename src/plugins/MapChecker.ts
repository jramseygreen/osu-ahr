import { Lobby } from "..";
import { BanchoResponseType } from "../parsers";
import { WebApiClient } from "../webapi/WebApiClient";
import { Beatmap, FetchBeatmapError, FetchBeatmapErrorReason } from "../webapi/Beatmapsets";
import { Player } from "../Player";
import { LobbyPlugin } from "./LobbyPlugin";
import log4js from "log4js";
import config from "config";
import { PlayMode } from "../Modes";
import { validateOption } from "../libs/OptionValidator";
import { BeatmapRepository } from "../webapi/BeatmapRepository";

export type MapCheckerOption = {
  enabled: boolean;
  num_violations_allowed: number; // Number of times violations are allowed
  star_min: number;
  star_max: number;
  length_min: number;
  length_max: number;
  gamemode: PlayMode;
  allow_convert: boolean;
};

export type MapCheckerUncheckedOption =
  { [key in keyof MapCheckerOption]?: any } & { num_violations_to_skip?: any, allowConvert?: any };


export class MapChecker extends LobbyPlugin {
  option: MapCheckerOption;
  webApiClient: WebApiClient | null;
  lastMapId: number = 0;
  checkingMapId: number = 0;
  numViolations: number = 0;
  validator: MapValidator;

  constructor(lobby: Lobby, client: WebApiClient | null = null, option: Partial<MapCheckerUncheckedOption> = {}) {
    super(lobby, "MapChecker", "mapChecker");
    const d = { ...config.get<MapCheckerUncheckedOption>(this.pluginName), ...option } as MapCheckerUncheckedOption;
    validateMapchekerOption(d);
    this.option = d as MapCheckerOption;

    this.webApiClient = client;
    this.validator = new MapValidator(this.option, this.logger);
    this.registerEvents();
  }

  private registerEvents(): void {
    this.lobby.JoinedLobby.once(a => this.onJoinedLobby());
    this.lobby.ReceivedChatCommand.on(a => this.onReceivedChatCommand(a.command, a.param, a.player));
    this.lobby.ReceivedBanchoResponse.on(a => {
      switch (a.response.type) {
        case BanchoResponseType.BeatmapChanged:
          this.onBeatmapChanged(a.response.params[0], a.response.params[1]);
          break;
        case BanchoResponseType.HostChanged:
          this.cancelCheck();
          break;
        case BanchoResponseType.BeatmapChanging:
          this.checkingMapId = 0;
          break;
        case BanchoResponseType.MatchStarted:
          this.onMatchStarted();
          break;
      }
    });
  }

  private onJoinedLobby(): void {
    if (this.option.enabled) {
      this.SendPluginMessage("enabledMapChecker");
    }
  }

  private onMatchStarted() {
    if (this.checkingMapId) {
      this.lastMapId = this.checkingMapId;
    }
    this.cancelCheck();
  }

  private onBeatmapChanged(mapId: number, mapTitle: string) {
    if (this.option.enabled) {
      this.checkingMapId = mapId;
      this.check(mapId, mapTitle);
    }
  }

  private onReceivedChatCommand(command: string, param: string, player: Player): void {
    if (command == "!r" || command == "!regulation") {
      this.lobby.SendMessageWithCoolTime(this.getRegulationDescription(), "regulation", 10000);
      return;
    }

    if (player.isAuthorized) {
      this.processOwnerCommand(command, param);
    }
  }

  processOwnerCommand(command: string, param: string) {
    try {
      const p = parseMapcheckerOwenerCommand(command, param);
      if (p === undefined) return;

      if (p.enabled !== undefined) {
        this.SetEnabled(p.enabled);
      }
      if (p.num_violations_allowed !== undefined) {
        this.option.num_violations_allowed = p.num_violations_allowed;
        this.logger.info("num_violations_allowed was set to " + p.num_violations_allowed);
      }
      let changed = false;
      if (p.star_min !== undefined) {
        this.option.star_min = p.star_min;
        if (this.option.star_max <= this.option.star_min && this.option.star_max != 0) {
          this.option.star_max = 0;
        }
        changed = true;
      }
      if (p.star_max !== undefined) {
        this.option.star_max = p.star_max;
        if (this.option.star_max <= this.option.star_min && this.option.star_max != 0) {
          this.option.star_min = 0;
        }
        changed = true;
      }
      if (p.length_min !== undefined) {
        this.option.length_min = p.length_min;
        if (this.option.length_max <= this.option.length_min && this.option.length_max != 0) {
          this.option.length_max = 0;
        }
        changed = true;
      }
      if (p.length_max !== undefined) {
        this.option.length_max = p.length_max;
        if (this.option.length_max <= this.option.length_min && this.option.length_max != 0) {
          this.option.length_min = 0;
        }
        changed = true;
      }
      if (p.gamemode !== undefined) {
        this.option.gamemode = p.gamemode;
        changed = true;
      }
      if (p.allow_convert !== undefined) {
        this.option.allow_convert = p.allow_convert;
        changed = true;
      }

      if (changed) {
        const m = "new regulation: " + this.validator.GetDescription();
        this.lobby.SendMessage(m);
        this.logger.info(m);
      }
    } catch (e: any) {
      this.logger.warn(e.message);
    }
  }

  getRegulationDescription(): string {
    if (this.option.enabled) {
      return this.validator.GetDescription();
    } else {
      return "disabled (" + this.validator.GetDescription() + ")";
    }
  }

  SetEnabled(v: boolean): void {
    if (v == this.option.enabled) return;

    if (v) {
      this.SendPluginMessage("enabledMapChecker");
      this.lobby.SendMessage("mapChecker Enabled");
      this.logger.info("mapChecker Enabled"); // TODO check behavior
    } else {
      this.SendPluginMessage("disabledMapChecker");
      this.lobby.SendMessage("mapChecker Disabled");
      this.logger.info("mapChecker Disabled");
    }
    this.option.enabled = v;
  }

  private async cancelCheck() {
    this.checkingMapId = 0;
    this.numViolations = 0;
  }

  private async check(mapId: number, mapTitle: string): Promise<void> {

    try {
      const map = await BeatmapRepository.getBeatmap(mapId, this.option.gamemode, this.option.allow_convert);

      if (mapId != this.checkingMapId) {
        this.logger.info(`target map is already changed. checked:${mapId}, current:${this.checkingMapId}`);
        return;
      }

      const r = this.validator.RateBeatmap(map);
      if (0 < r.rate) {
        this.rejectUnfitMap(r.message);
      } else {
        this.acceptMap();
      }
    } catch (e: any) {
      if (e instanceof FetchBeatmapError) {
        switch (e.reason) {
          case FetchBeatmapErrorReason.FormatError:
            this.logger.error(`Couldn't parse the webpage. checked:${mapId}`);
            break;
          case FetchBeatmapErrorReason.NotFound:
            this.logger.info(`Map not found. checked:${mapId}`);
            this.rejectDeletedMap();
            break;
          case FetchBeatmapErrorReason.PlayModeMismatched:
            this.logger.info(`Map not found. checked:${mapId}`);
            this.rejectUnfitMap(`Gamemode Mismatched. Pick ${this.option.gamemode.name} map.`);
            break;
        }
      } else {
        this.logger.error(`unexpected error. checking:${mapId}, err:${e.message}`);
      }
    }

    let map = await this.getBeatmap(mapId);
    if (!map) {
      this.logger.warn(`couldn't find map id:${mapId}, title:${mapTitle}, retrying...`);
      map = await this.getBeatmap(mapId);
    }
    if (!map) {
      this.logger.error(`couldn't find map id:${mapId}, title:${mapTitle}, skip checking`);
      this.rejectDeletedMap();
      return;
    }
    if (mapId != this.checkingMapId) {
      this.logger.info(`target map is changed. checked:${mapId}, current:${this.checkingMapId}`);
      return;
    }
  }

  private skipHost(): void {
    let msg = `The number of violations has reached ${this.option.num_violations_allowed}. Skipped ${this.lobby.host?.escaped_name}`;
    this.logger.info(msg);
    this.lobby.SendMessage(msg);
    this.SendPluginMessage("skip");
  }

  private rejectDeletedMap(): void {
    this.numViolations += 1;
    this.logger.info(`Rejected the map already deleted on the website. ${this.lobby.host?.escaped_name} (${this.numViolations} / ${this.option.num_violations_allowed})`);
    this.lobby.SendMessage("!mp map " + this.lastMapId + " | Rejected the map already deleted on the website.");
    this.checkingMapId = 0;

    if (this.option.num_violations_allowed != 0 && this.option.num_violations_allowed <= this.numViolations) {
      this.skipHost();
    }
  }

  private rejectUnfitMap(reason: string): void {
    this.numViolations += 1;
    this.logger.info(`Rejected the map selected by ${this.lobby.host?.escaped_name} (${this.numViolations} / ${this.option.num_violations_allowed})`);
    this.lobby.SendMessage("!mp map " + this.lastMapId);
    this.lobby.SendMessage(reason);
    this.checkingMapId = 0;

    if (this.option.num_violations_allowed != 0 && this.option.num_violations_allowed <= this.numViolations) {
      this.skipHost();
    }
  }

  private acceptMap(): void {
    this.SendPluginMessage("validatedMap");
    this.lastMapId = this.lobby.mapId;

    this.lobby.SendMessage("!mp map " + this.lobby.mapId + " " + this.option.gamemode.value);
  }

  private async getBeatmap(mapId: number): Promise<Beatmap | undefined> {
    try {
      return await BeatmapRepository.getBeatmap(mapId, this.option.gamemode, this.option.allow_convert);
    } catch (e: any) {
      if (e instanceof Error) {
        this.logger.error(e.message);
      } else {
        this.logger.error(e);
      }
    }
  }

  GetPluginStatus(): string {
    return `-- Mapchecker -- regulation : ${this.getRegulationDescription()}`;
  }
}

export function secToTimeNotation(sec: number): string {
  let m = Math.floor(sec / 60);
  let s = Math.round(sec - m * 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export class MapValidator {
  logger: log4js.Logger;
  option: MapCheckerOption;

  constructor(option: MapCheckerOption, logger: log4js.Logger) {
    this.option = option;

    this.logger = logger;
  }

  RateBeatmap(map: Beatmap): { rate: number, message: string } {
    let r = 0;

    let rs = { rate: r, message: "" };

    const mapmode = PlayMode.from(map.mode);
    if (mapmode != this.option.gamemode && this.option.gamemode != null) {
      r += 1;
    }

    if (this.option.star_min != 0 && map.difficulty_rating < this.option.star_min) {
      r += parseFloat((this.option.star_min - map.difficulty_rating).toFixed(2));
    }

    if (this.option.star_max != 0 && this.option.star_max < map.difficulty_rating) {
      r += parseFloat((map.difficulty_rating - this.option.star_max).toFixed(2));
    }

    if (this.option.length_min != 0 && map.total_length < this.option.length_min) {
      r += (this.option.length_min - map.total_length) / 60.0;
    }

    if (this.option.length_max != 0 && this.option.length_max < map.total_length) {
      r += (map.total_length - this.option.length_max) / 60.0;
    }

    if (0.01 <= r) {
      rs.message
        = `picked map: ${map.url} ${map.beatmapset?.title} star=${map.difficulty_rating} length=${secToTimeNotation(map.total_length)}` + "\n"
        + `Violation of Regulation : ${this.GetDescription()}`;
      rs.rate = Math.min(Math.max(r, 0.45), 0.9);
    } else if (0.001 < r) {
      rs.message
        = `picked map: ${map.url} ${map.beatmapset?.title} star=${map.difficulty_rating} length=${secToTimeNotation(map.total_length)}` + "\n"
        + `Violation of Regulation : ${this.GetDescription()}` + "\n"
        + `you can skip current host with '!skip' voting command.`
        ;
      rs.rate = 0;
    }

    return rs;
  }

  GetDescription(): string {
    let d_star = "";
    let d_length = "";
    let d_gamemode = "";
    if (this.option.gamemode != null) {
      d_gamemode = ` mode: ${this.option.gamemode}`;
      if (this.option.gamemode != PlayMode.Osu) {
        if (this.option.allow_convert) {
          d_gamemode += " (converts allowed)";
        }
        else {
          d_gamemode += " (converts disallowed)";
        }
      }
    }

    if (this.option.star_min != 0 && this.option.star_max != 0) {
      d_star = `${this.option.star_min.toFixed(2)} <= difficulty <= ${this.option.star_max.toFixed(2)}`;
    } else if (this.option.star_min != 0) {
      d_star = `${this.option.star_min.toFixed(2)} <= difficulty`;
    } else if (this.option.star_max != 0) {
      d_star = `difficulty <= ${this.option.star_max.toFixed(2)}`;
    }

    if (this.option.length_min != 0 && this.option.length_max != 0) {
      d_length = `${secToTimeNotation(this.option.length_min)} <= length <= ${secToTimeNotation(this.option.length_max)}`;
    } else if (this.option.length_min != 0) {
      d_length = `${secToTimeNotation(this.option.length_min)} <= length`;
    } else if (this.option.length_max != 0) {
      d_length = `length <= ${secToTimeNotation(this.option.length_max)}`;
    }

    if (d_star != "" && d_length != "") {
      return `${d_star}, ${d_length}, ${d_gamemode}`;
    } else if (d_star == "" && d_length == "") {
      return "no regulation";
    } else {
      return d_star + d_length + d_gamemode;
    }
  }
}

function validateMapchekerOption(option: MapCheckerUncheckedOption): option is Partial<MapCheckerOption> {
  if (option.enabled !== undefined) {
    option.enabled = validateOption.bool("MapChecker.enabled", option.enabled);
  }

  if (option.star_min !== undefined) {
    option.star_min = validateOption.number("MapChecker.star_min", option.star_min, 0);
  }

  if (option.star_max !== undefined) {
    option.star_max = validateOption.number("MapChecker.star_max", option.star_max, 0);
  }

  if (option.length_min !== undefined) {
    option.length_min = validateOption.number("MapChecker.length_min", option.length_min, 0);
  }

  if (option.length_max !== undefined) {
    option.length_max = validateOption.number("MapChecker.length_max", option.length_max, 0);
  }

  if (option.star_max !== undefined && option.star_min !== undefined && option.star_max <= option.star_min && option.star_max != 0) {
    option.star_min = 0;
  }

  if (option.length_max !== undefined && option.length_min !== undefined && option.length_max <= option.length_min && option.length_max != 0) {
    option.length_min = 0;
  }

  if (option.gamemode !== undefined) {
    if (typeof option.gamemode == "string") {
      try {
        option.gamemode = PlayMode.from(option.gamemode, true);
      } catch {
        throw new Error("option MapChecker#gamemode must be [osu | fruits | taiko | mania].");
      }
    }

    if (!(option.gamemode instanceof PlayMode)) {
      throw new Error("option MapChecker#gamemode must be [osu | fruits | taiko | mania].");
    }
  }

  if (option.num_violations_to_skip !== undefined) {
    option.num_violations_allowed = option.num_violations_to_skip;
  }
  if (option.num_violations_allowed !== undefined) {
    option.num_violations_allowed = validateOption.number("MapChecker.num_violations_allowed", option.num_violations_allowed, 0);
  }

  if (option.allowConvert !== undefined) {
    option.allow_convert = option.allowConvert;
  }
  if (option.allow_convert !== undefined) {
    option.allow_convert = validateOption.bool("MapChecker.allow_convert", option.allow_convert);
  }
  return true;
}

/**
 * function for processing owner commands
 * Separated from MapChecker for ease of testing
 */
export function parseMapcheckerOwenerCommand(command: string, param: string): Partial<MapCheckerOption> | undefined {
  let option: undefined | MapCheckerUncheckedOption = undefined;
  command = command.toLocaleLowerCase();
  if (command == "*mapchecker_enable") {
    return { enabled: true };
  }
  if (command == "*mapchecker_disable") {
    option = { enabled: false };
  }

  if (command.startsWith("*regulation")) {
    if (param.indexOf("=") != -1) {
      option = parseRegulationSetter(param);
    } else {
      const params = param.split(/\s+/).map(s => s.toLowerCase()).filter(s => s != "");
      option = parseRegulationCommand(params);
    }
  }

  if (command == "*no" && param.startsWith("regulation")) {
    const params = param.split(/\s+/).map(s => s.toLowerCase()).filter(s => s != "");
    if (params.length == 1) {
      option = { enabled: false };
    } else {
      option = parseNoRegulationCommand(params[1]);
    }
  }
  if (option != undefined) {
    validateMapchekerOption(option);
  }
  return option;
}

function parseRegulationCommand(params: string[]): MapCheckerUncheckedOption {
  switch (unifyParamName(params[0])) {
    case "enabled":
      return { enabled: true };
    case "disabled":
      return { enabled: false };
    case "num_violations_allowed":
      if (params.length < 2) throw new Error("missing parameter. *regulation num_violations_allowed [number]");
      return { num_violations_allowed: params[1] };
    case "star_min":
      if (params.length < 2) throw new Error("missing parameter. *regulation star_min [number]");
      return { star_min: params[1] };
    case "star_max":
      if (params.length < 2) throw new Error("missing parameter. *regulation star_max [number]");
      return { star_max: params[1] };
    case "length_min":
      if (params.length < 2) throw new Error("missing parameter. *regulation length_min [number]");
      return { length_min: params[1] };
    case "length_max":
      if (params.length < 2) throw new Error("missing parameter. *regulation length_max [number]");
      return { length_max: params[1] };
    case "gamemode":
      if (params.length < 2) throw new Error("missing parameter. *regulation gamemode [osu | fruits | taiko | mania]");
      return { gamemode: params[1] };
    case "allow_convert":
      if (params.length < 2) {
        return { allow_convert: true };
      } else {
        return { gamemode: params[1] };
      }

    case "disallow_convert":
      return { allow_convert: false };
  }
  throw new Error("missing parameter.  *regulation [enable | disable | star_min | star_max | length_min | length_max | gamemode | num_violations_allowed] <...params>");
}

function parseNoRegulationCommand(param: string): MapCheckerUncheckedOption | undefined {
  switch (unifyParamName(param)) {
    case "num_violations_allowed":
      return { num_violations_allowed: 0 };
    case "star_min":
      return { star_min: 0 };
    case "star_max":
      return { star_max: 0 };
    case "length_min":
      return { length_min: 0 };
    case "length_max":
      return { length_max: 0 };
    case "gamemode":
      return { gamemode: PlayMode.Osu, allow_convert: true };
    case "allow_convert":
      return { allow_convert: false };
  }
}

function parseRegulationSetter(param: string): MapCheckerUncheckedOption {
  const re = /([0-9a-zA-Z_\-]+)\s*=\s*([^\s,]+)/g;
  let m = re.exec(param);
  let result: { [key: string]: string } = {};
  while (m) {
    const name = unifyParamName(m[1]);
    const value = m[2];
    result[name] = value;
  }
  return result;
}

function unifyParamName(name: string): string {
  name = name.toLowerCase();

  if (name.includes("star") || name.includes("diff")) {
    if (name.includes("low") || name.includes("min")) {
      return "star_min";
    } else if (name.includes("up") || name.includes("max")) {
      return "star_max"
    }
  } else if (name.includes("len")) {
    if (name.includes("low") || name.includes("min")) {
      return "length_min"
    } else if (name.includes("up") || name.includes("max")) {
      return "length_max"
    }
  } else if (name.startsWith("enable")) {
    return "enabled";
  } else if (name.startsWith("disable")) {
    return "disabled";
  } else if (name == "num_violations_to_skip" || name.includes("violations")) {
    return "num_violations_allowed";
  } else if (name == "allowConvert") {
    return "allow_convert";
  } else if (name == "disallowConver") {
    return "disallow_convert";
  }
  return name;
}