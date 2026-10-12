#==============================================================================
# Soul Link Tracker for Pokémon Infinite Fusion
#
# Writes the current party and PC boxes to "SoulLink/state.json" inside the
# game folder. The helper script in that folder sends the file to the
# Soul Link server, which links the Pokémon of both players by route.
#
# Every Pokémon gets a tag (@soullink_tag) the first time the tracker sees it.
# The tag stores the encounter route and is saved together with the Pokémon,
# so links survive fusing, unfusing and evolving.
#==============================================================================
module SoulLinkTracker
  VERSION        = "1.4.0"
  OUTPUT_DIR     = "SoulLink"
  OUTPUT_FILE    = "SoulLink/state.json"
  TEMP_FILE      = "SoulLink/state.json.tmp"
  ERROR_FILE     = "SoulLink/error.log"
  SPRITE_DIR     = "SoulLink/sprites"
  SPRITE_TEMP    = "SoulLink/sprites/_tmp.png"
  PARTY_INTERVAL = 0.5   # seconds between party scans (HP updates)
  FULL_INTERVAL  = 4.0   # seconds between full scans (party + PC boxes)
  SPRITES_PER_SCAN = 3   # max. sprites exported per full scan (each takes a few ms)

  @busy         = false
  @next_party   = 0
  @next_full    = 0
  @box_entries  = []
  @last_json    = nil
  @last_trainer = nil
  @error_logged = false
  @battle       = nil     # battle in progress (for causes of death)
  @sprite_files = {}      # sprite keys that already exist as PNG
  @sprite_failed = {}     # Pokémon whose sprite could not be drawn
  @sprites_off  = false   # set when this game build cannot save bitmaps

  module_function

  #----------------------------------------------------------------------------
  # Main loop, called after every Graphics.update
  #----------------------------------------------------------------------------
  def tick
    return if @busy
    now = Time.now.to_f
    return if now < @next_party
    @next_party = now + PARTY_INTERVAL
    return if !$Trainer || !$PokemonGlobal || !$PokemonStorage
    @busy = true
    begin
      if !$Trainer.equal?(@last_trainer)   # another save file was loaded
        @last_trainer = $Trainer
        @next_full = 0
        @last_json = nil
      end
      in_battle = $game_temp && $game_temp.in_battle
      if !in_battle && now >= @next_full
        @next_full = now + FULL_INTERVAL
        full_scan
      end
      write_state(build_state(in_battle))
    rescue Exception => e
      log_error(e)
    ensure
      @busy = false
    end
  end

  #----------------------------------------------------------------------------
  # Tagging
  #----------------------------------------------------------------------------
  def tag_of(pkmn)
    return pkmn.instance_variable_get(:@soullink_tag)
  end

  def absorbed_of(pkmn)
    return pkmn.instance_variable_get(:@soullink_absorbed)
  end

  def fusion?(pkmn)
    return pkmn.isFusion? rescue false
  end

  def ensure_tag(pkmn)
    return nil if !pkmn || pkmn.egg?
    tag = tag_of(pkmn)
    return tag if tag
    seq = ($PokemonGlobal.soullink_seq || 0) + 1
    $PokemonGlobal.soullink_seq = seq
    tag = {
      "id"         => "#{seq}-#{(pkmn.personalID || 0).to_s(16)}",
      "seq"        => seq,
      "route"      => route_name(pkmn),
      "map"        => pkmn.obtain_map || 0,
      "method"     => pkmn.obtain_method || 0,
      "first_species" => pkmn.species.to_s
    }
    pkmn.instance_variable_set(:@soullink_tag, tag)
    return tag
  end

  def route_name(pkmn)
    text = pkmn.obtain_text
    return utf8(text) if text && !text.empty?
    map_id = pkmn.obtain_map || 0
    if map_id > 0
      name = pbGetMapNameFromId(map_id) rescue nil
      return utf8(name) if name && !name.empty?
      return "Map #{map_id}"
    end
    return "Unbekannt"
  end

  # Head and body species symbols of a fused Pokémon, used to recognise the
  # Pokémon that comes back out when it is unfused.
  def fusion_parts(pkmn)
    return [] if !fusion?(pkmn)
    parts = []
    [get_head_number_from_symbol(pkmn.species), get_body_number_from_symbol(pkmn.species)].each do |num|
      parts << GameData::Species.get(num).id.to_s rescue nil
    end
    return parts.compact
  end

  # Called right before two Pokémon are fused; remembers the tag of the one
  # that is absorbed so the link survives the fusion.
  def on_fuse(survivor, absorbed)
    ensure_tag(survivor)
    ensure_tag(absorbed)
    return [tag_of(absorbed), absorbed_of(absorbed)]
  end

  def after_fuse(survivor, absorbed_info)
    return if !survivor || !fusion?(survivor) || !absorbed_info[0]
    survivor.instance_variable_set(:@soullink_absorbed, {
      "tag"     => absorbed_info[0],
      "species" => fusion_parts(survivor)
    })
  end

  # Gives the tag back to a Pokémon that came out of an unfused Pokémon.
  def restore_unfused(all)
    owners = all.select { |p| absorbed_of(p) && !fusion?(p) }
    return if owners.empty?
    untagged = all.select { |p| !p.egg? && !tag_of(p) }
    owners.each do |owner|
      info = absorbed_of(owner)
      species = info["species"] || []
      match = untagged.find { |p| species.include?(p.species.to_s) && p.species.to_s != owner.species.to_s }
      match ||= untagged.find { |p| species.include?(p.species.to_s) }
      match ||= untagged[0] if untagged.length == 1
      if match
        match.instance_variable_set(:@soullink_tag, info["tag"])
        untagged.delete(match)
      end
      owner.instance_variable_set(:@soullink_absorbed, nil)
    end
  end

  #----------------------------------------------------------------------------
  # Scanning
  #----------------------------------------------------------------------------
  def party_list
    return $Trainer.party.compact
  end

  def box_list
    list = []
    storage = $PokemonStorage
    for box in 0...storage.maxBoxes
      box_obj = storage[box]
      next if !box_obj
      for slot in 0...storage.maxPokemon(box)
        pkmn = storage[box, slot]
        list << [pkmn, box, slot, box_obj.name] if pkmn
      end
    end
    return list
  end

  def full_scan
    boxes = box_list
    all = party_list + boxes.map { |b| b[0] }
    restore_unfused(all)
    all.each { |p| ensure_tag(p) }
    all.each do |p|
      info = absorbed_of(p)
      info["species"] = fusion_parts(p) if info && fusion?(p)
    end
    export_sprites(party_list, boxes.map { |b| b[0] })
    @box_entries = boxes.map { |pkmn, box, slot, name| pokemon_entry(pkmn, box, slot, name) }.compact
  end

  #----------------------------------------------------------------------------
  # Sprites: the exact picture the game shows for a Pokémon (chosen alt sprite,
  # custom/autogen, shiny colours, size) is saved once per variant as
  # SoulLink/sprites/<key>.png. The helper uploads new files to the server.
  #----------------------------------------------------------------------------

  # The sprite the game would use for this Pokémon, without loading anything.
  # nil if the game has not picked one yet.
  def current_pif_sprite(pkmn)
    if $PokemonSystem && $PokemonSystem.random_sprites
      return pkmn.pif_sprite
    end
    subs = $PokemonSystem && $PokemonSystem.alt_sprite_substitutions
    return nil if !subs
    return subs[get_sprite_substitution_id_from_dex_number(pkmn.species)]
  rescue Exception
    return nil
  end

  def sprite_key(pkmn)
    return nil if !pkmn || pkmn.egg?
    if (pkmn.isTripleFusion? rescue false)
      base = "TRIPLE-#{pkmn.species}"
    else
      s = current_pif_sprite(pkmn)
      return nil if !s
      base = [s.type, s.head_id, s.body_id, s.alt_letter, s.local_path ? "L" : ""].join("-")
    end
    if pkmn.shiny?
      base += "-S#{pkmn.body_shiny ? 1 : 0}#{pkmn.head_shiny ? 1 : 0}"
    end
    scale = (pkmn.sprite_scale rescue 1) || 1
    base += "-X#{scale}" if scale != 1
    return base.gsub(/[^A-Za-z0-9]+/, "-").gsub(/\A-|-\z/, "")[0, 80]
  end

  def sprite_path(key)
    return "#{SPRITE_DIR}/#{key}.png"
  end

  def sprite_exists?(key)
    return false if !key
    return true if @sprite_files[key]
    @sprite_files[key] = true if File.exist?(sprite_path(key))
    return @sprite_files[key] ? true : false
  end

  # Party Pokémon are always drawn (the game shows them anyway). Box Pokémon
  # only once the game has picked their sprite, so this never makes the game
  # download spritesheets for Pokémon nobody has looked at.
  def export_sprites(party, boxed)
    return if @sprites_off
    budget = SPRITES_PER_SCAN
    (party.map { |p| [p, true] } + boxed.map { |p| [p, false] }).each do |pkmn, in_party|
      break if budget <= 0
      next if !pkmn || pkmn.egg?
      key = sprite_key(pkmn)
      next if key.nil? && !in_party
      next if sprite_exists?(key)
      budget -= 1
      export_sprite(pkmn)
      return if @sprites_off
    end
  end

  def export_sprite(pkmn)
    failed_id = [pkmn.personalID, pkmn.species, pkmn.shiny?]
    return if @sprite_failed[failed_id]
    bmp = GameData::Species.sprite_bitmap_from_pokemon(pkmn)
    return if !bmp
    begin
      if !bmp.bitmap.respond_to?(:to_file)
        @sprites_off = true   # this build cannot save bitmaps: keep tracking without sprites
        return
      end
      key = sprite_key(pkmn)   # drawing may have picked the sprite just now
      if !key
        @sprite_failed[failed_id] = true   # game keeps no record of the sprite: nothing to name it by
        return
      end
      return if sprite_exists?(key)
      Dir.mkdir(OUTPUT_DIR) if !File.directory?(OUTPUT_DIR)
      Dir.mkdir(SPRITE_DIR) if !File.directory?(SPRITE_DIR)
      bmp.bitmap.to_file(SPRITE_TEMP)
      File.rename(SPRITE_TEMP, sprite_path(key))
      @sprite_files[key] = true
    ensure
      bmp.dispose rescue nil
    end
  rescue Exception => e
    @sprite_failed[failed_id] = true if failed_id   # don't retry this Pokémon every scan
    log_error(e)
  end

  #----------------------------------------------------------------------------
  # Causes of death: who knocked out one of the player's Pokémon, saved with
  # the Pokémon (@soullink_death) the first time it faints.
  #----------------------------------------------------------------------------
  STATUS_CAUSES = { :POISON => "Gift", :BURN => "Verbrennung" }

  def current_battle=(battle)
    @battle = battle
  end

  def death_of(pkmn)
    return pkmn.instance_variable_get(:@soullink_death)
  end

  # need_attacker: only record if a foe hit it (used while HP is still animating;
  # the faint hook records status/other causes afterwards)
  def record_death(battler, need_attacker = false)
    pkmn = battler.pokemon
    return if !pkmn || death_of(pkmn) || !battler.pbOwnedByPlayer?
    battle = battler.battle
    idx = battler.lastFoeAttacker.last
    foe = idx ? battle.battlers[idx] : nil
    foe = nil if foe && !foe.pokemon
    return if need_attacker && !foe
    info = { "wild" => battle.wildBattle? ? true : false }
    if foe
      info["by"] = utf8(foe.pokemon.speciesName)
      info["by_level"] = foe.level
      move = foe.lastMoveUsed
      info["move"] = utf8(GameData::Move.get(move).name) if move rescue nil
      if battle.trainerBattle?
        owner = battle.pbGetOwnerFromBattlerIndex(idx) rescue nil
        info["trainer"] = utf8(owner.full_name) if owner rescue nil
      end
    else
      info["cause"] = STATUS_CAUSES[battler.status] || "Sonstiges"
    end
    info["map"] = utf8(pbGetMapNameFromId($game_map.map_id)) if $game_map rescue nil
    pkmn.instance_variable_set(:@soullink_death, info)
  end

  #----------------------------------------------------------------------------
  # Failed encounters: a wild battle that ends without a catch. The server
  # decides whether it counts (first encounter on the route, dupe clause).
  #----------------------------------------------------------------------------
  BATTLE_RESULTS = { 1 => "besiegt", 2 => "verloren", 3 => "geflohen" }
  MAX_FAILS = 100

  # Evolution lines (base stage) of a Pokémon; both parts for a fusion
  def families_of(pkmn)
    parts = fusion?(pkmn) ? [get_head_number_from_symbol(pkmn.species), get_body_number_from_symbol(pkmn.species)] : [pkmn.species]
    return parts.map { |s| (GameData::Species.get(s).get_baby_species.to_s rescue nil) }.compact.uniq
  rescue Exception
    return []
  end

  # The wild Pokémon of a failed encounter, with its sprite for the overlay
  def wild_entry(pk)
    e = { "name" => utf8(pk.speciesName), "families" => families_of(pk), "fusion" => fusion?(pk) }
    e["dex"] = (GameData::Species.get(pk.species).id_number rescue nil)
    if e["fusion"]
      e["head"] = (GameData::Species.get(get_head_number_from_symbol(pk.species)).id_number rescue nil)
      e["body"] = (GameData::Species.get(get_body_number_from_symbol(pk.species)).id_number rescue nil)
    end
    begin
      key = sprite_key(pk)
      export_sprite(pk) if !@sprites_off && !sprite_exists?(key)
      key = sprite_key(pk)
      e["sprite"] = key if sprite_exists?(key)
    rescue Exception => err
      log_error(err)
    end
    return e
  end

  def after_battle(battle)
    return if !battle.wildBattle? || !battle.internalBattle
    full_scan   # tag a Pokémon caught just now before anything else gets a number
    return if battle.decision == 0 || battle.decision == 4
    seq = ($PokemonGlobal.soullink_seq || 0) + 1
    $PokemonGlobal.soullink_seq = seq
    wild = battle.pbParty(1).compact.map { |pk| wild_entry(pk) }
    fails = ($PokemonGlobal.soullink_fails ||= [])
    fails << {
      "id"     => "f#{seq}",
      "seq"    => seq,
      "route"  => utf8(pbGetMapNameFromId($game_map.map_id)),
      "result" => BATTLE_RESULTS[battle.decision] || "gescheitert",
      "wild"   => wild
    }
    fails.shift while fails.length > MAX_FAILS
  end

  # Party Pokémon at 0 HP while the faint animation is still running
  def record_deaths_in_battle
    return if !@battle
    @battle.battlers.each do |b|
      next if !b || !b.pokemon || b.hp > 0
      record_death(b, true)
    end
  end

  def pokemon_entry(pkmn, box, slot, box_name = nil)
    return nil if pkmn.egg?
    tag = ensure_tag(pkmn)
    tags = [tag]
    absorbed = absorbed_of(pkmn)
    tags << absorbed["tag"] if absorbed && absorbed["tag"] && fusion?(pkmn)
    entry = {
      "tags"     => tags,
      "species"  => pkmn.species.to_s,
      "species_name" => utf8(pkmn.speciesName),
      "name"     => utf8(pkmn.name),
      "nicknamed" => pkmn.nicknamed? ? true : false,
      "level"    => pkmn.level,
      "hp"       => pkmn.hp,
      "maxhp"    => pkmn.totalhp,
      "status"   => pkmn.status.to_s,
      "shiny"    => pkmn.shiny? ? true : false,
      "gender"   => pkmn.gender,
      "fusion"   => fusion?(pkmn),
      "box"      => box,
      "slot"     => slot
    }
    entry["box_name"] = utf8(box_name) if box_name
    key = sprite_key(pkmn)
    entry["sprite"] = key if sprite_exists?(key)
    death = death_of(pkmn)
    entry["death"] = death if death
    # Infinite Fusion dex numbers: used to find the sprite in the official sprite
    # archive while the game has not exported its own picture yet
    entry["dex"] = (GameData::Species.get(pkmn.species).id_number rescue nil)
    entry["families"] = families_of(pkmn)   # for the dupe clause
    if entry["fusion"]
      head = GameData::Species.get(get_head_number_from_symbol(pkmn.species)) rescue nil
      body = GameData::Species.get(get_body_number_from_symbol(pkmn.species)) rescue nil
      entry["head"] = { "species" => head.id.to_s, "name" => utf8(head.name), "num" => head.id_number } if head
      entry["body"] = { "species" => body.id.to_s, "name" => utf8(body.name), "num" => body.id_number } if body
    end
    return entry
  end

  def build_state(in_battle)
    begin
      record_deaths_in_battle if in_battle
    rescue Exception => e
      log_error(e)
    end
    party = []
    party_list.each_with_index do |pkmn, i|
      entry = pokemon_entry(pkmn, -1, i)
      party << entry if entry
    end
    map_name = ($game_map ? pbGetMapNameFromId($game_map.map_id) : "") rescue ""
    return {
      "mod_version"  => VERSION,
      "game_version" => (Settings::GAME_VERSION_NUMBER rescue "?"),
      "trainer" => {
        "name"   => utf8($Trainer.name),
        "id"     => ($Trainer.id rescue nil),   # random per save file: tells a new save from the old one
        "badges" => ($Trainer.badge_count rescue 0),
        "money"  => ($Trainer.money rescue 0)
      },
      "map"       => utf8(map_name),
      "in_battle" => in_battle ? true : false,
      "party"     => party,
      "boxes"     => @box_entries,
      "fails"     => ($PokemonGlobal.soullink_fails || [])
    }
  end

  #----------------------------------------------------------------------------
  # Output
  #----------------------------------------------------------------------------
  def write_state(state)
    json = to_json(state)
    return if json == @last_json
    Dir.mkdir(OUTPUT_DIR) if !File.directory?(OUTPUT_DIR)
    File.open(TEMP_FILE, "wb") { |f| f.write(json) }
    begin
      File.rename(TEMP_FILE, OUTPUT_FILE)
    rescue SystemCallError
      return   # the helper is reading the file right now; retry next tick
    end
    @last_json = json
  end

  def log_error(e)
    return if @error_logged
    @error_logged = true
    Dir.mkdir(OUTPUT_DIR) if !File.directory?(OUTPUT_DIR)
    File.open(ERROR_FILE, "ab") do |f|
      f.write("[#{Time.now}] #{e.class}: #{e.message}\n#{(e.backtrace || [])[0, 10].join("\n")}\n\n")
    end
  rescue Exception
  end

  def utf8(value)
    s = value.to_s.dup
    s.force_encoding("UTF-8")
    s = s.scrub("?") if !s.valid_encoding?
    return s
  end

  def to_json(value)
    case value
    when Hash   then "{" + value.map { |k, v| to_json(k.to_s) + ":" + to_json(v) }.join(",") + "}"
    when Array  then "[" + value.map { |v| to_json(v) }.join(",") + "]"
    when String then "\"" + utf8(value).gsub(/["\\\x00-\x1f]/) { |c| json_escape(c) } + "\""
    when Symbol then to_json(value.to_s)
    when Integer then value.to_s
    when Float  then value.finite? ? value.to_s : "0"
    when true   then "true"
    when false  then "false"
    when nil    then "null"
    else to_json(value.to_s)
    end
  end

  def json_escape(c)
    case c
    when "\"" then "\\\""
    when "\\" then "\\\\"
    when "\n" then "\\n"
    when "\r" then "\\r"
    when "\t" then "\\t"
    else format("\\u%04x", c.ord)
    end
  end
end

#==============================================================================
# Persistent counter for the order in which Pokémon were first seen
#==============================================================================
class PokemonGlobalMetadata
  attr_accessor :soullink_seq
  attr_accessor :soullink_fails   # wild battles that ended without a catch
end

#==============================================================================
# Keep links when Pokémon are fused
#==============================================================================
alias soullink_original_pbFuse pbFuse

# Extra arguments (6.8+: fusion_pif_sprite) are passed through unchanged.
def pbFuse(pokemon_body, pokemon_head, *args)
  info = nil
  begin
    info = SoulLinkTracker.on_fuse(pokemon_body, pokemon_head)
  rescue Exception => e
    SoulLinkTracker.log_error(e)
  end
  ret = soullink_original_pbFuse(pokemon_body, pokemon_head, *args)
  begin
    SoulLinkTracker.after_fuse(pokemon_body, info) if ret && info
  rescue Exception => e
    SoulLinkTracker.log_error(e)
  end
  return ret
end

#==============================================================================
# Remember the running battle and record who knocked out the player's Pokémon
#==============================================================================
if defined?(PokeBattle_Battle) && defined?(PokeBattle_Battler)
  class PokeBattle_Battle
    alias soullink_original_pbStartBattle pbStartBattle

    def pbStartBattle(*args)
      SoulLinkTracker.current_battle = self
      ret = soullink_original_pbStartBattle(*args)
      begin
        SoulLinkTracker.after_battle(self)
      rescue Exception => e
        SoulLinkTracker.log_error(e)
      end
      return ret
    ensure
      SoulLinkTracker.current_battle = nil
    end
  end

  class PokeBattle_Battler
    alias soullink_original_pbFaint pbFaint

    def pbFaint(*args)
      begin
        SoulLinkTracker.record_death(self) if fainted? && !@fainted
      rescue Exception => e
        SoulLinkTracker.log_error(e)
      end
      return soullink_original_pbFaint(*args)
    end
  end
end

#==============================================================================
# Run the tracker every frame (it throttles itself)
#==============================================================================
module Graphics
  class << Graphics
    alias soullink_original_update update
  end

  def self.update
    soullink_original_update
    SoulLinkTracker.tick
  end
end
