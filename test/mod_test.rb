# Runs the Infinite Fusion mod against a tiny fake game and checks the output.
#   ruby test/mod_test.rb
require "json"
require "tmpdir"
require "minitest/autorun"

NB_POKEMON = 501
DEX = { 1 => :BULBASAUR, 19 => :RATTATA, 25 => :PIKACHU, 16 => :PIDGEY, 29 => :NIDORANfE }

module Settings
  GAME_VERSION_NUMBER = "6.8.2"
end

module GameData
  class Species
    attr_reader :id, :id_number, :name
    def initialize(num)
      @id_number = num
      @id = DEX[num] || :"B#{num / NB_POKEMON}H#{num % NB_POKEMON}"
      @name = @id.to_s.capitalize
    end
    def self.get(x)
      return new(x) if x.is_a?(Integer)
      num = DEX.key(x)
      return new(num) if num
      m = x.to_s.match(/B(\d+)H(\d+)/)
      new(m[1].to_i * NB_POKEMON + m[2].to_i)
    end
  end
end

def get_head_number_from_symbol(id) = id.to_s.match(/(?<=H)\d+/)[0].to_i
def get_body_number_from_symbol(id) = id.to_s.match(/\d+/)[0].to_i
def pbGetMapNameFromId(id) = { 1 => "Pallet Town", 2 => "Route 1", 3 => "Viridian Forest" }[id] || ""

# Simplified sprite system of the game (PIFSprite + per-species substitutions).
PIFSprite = Struct.new(:type, :head_id, :body_id, :alt_letter, :local_path)

class PokemonSystem
  attr_accessor :random_sprites, :alt_sprite_substitutions
  def initialize = (@random_sprites = false; @alt_sprite_substitutions = {})
end

def get_sprite_substitution_id_from_dex_number(species) = GameData::Species.get(species).id_number

class FakeBitmap
  def initialize(label) = (@label = label)
  def to_file(path) = File.binwrite(path, "\x89PNG#{@label}")
end

class FakeAnimatedBitmap
  attr_reader :bitmap, :disposed
  def initialize(label) = (@bitmap = FakeBitmap.new(label))
  def dispose = (@disposed = true)
end

module GameData
  class Species
    class << self
      attr_accessor :drawn
    end
    # Like the game: drawing picks (and remembers) a sprite if none was chosen yet.
    def self.sprite_bitmap_from_pokemon(pkmn)
      (self.drawn ||= []) << pkmn.species
      id = get_sprite_substitution_id_from_dex_number(pkmn.species)
      s = ($PokemonSystem.alt_sprite_substitutions[id] ||= PIFSprite.new(:BASE, id, nil, "", nil))
      FakeAnimatedBitmap.new("#{s.head_id}#{s.alt_letter}#{pkmn.shiny? ? 'shiny' : ''}")
    end
  end
end

class Pokemon
  attr_accessor :species, :name, :level, :hp, :totalhp, :obtain_map, :obtain_method, :obtain_text, :personalID, :status
  attr_accessor :pif_sprite, :shiny, :body_shiny, :head_shiny
  def isTripleFusion? = false
  def sprite_scale = 1
  def initialize(species, map, level = 5)
    @species = species
    @obtain_map = map
    @obtain_method = 0
    @level = level
    @hp = @totalhp = 20
    @personalID = rand(2**32)
    @status = :NONE
  end
  def egg? = false
  def isFusion? = GameData::Species.get(@species).id_number > NB_POKEMON
  def speciesName = GameData::Species.get(@species).name
  def nicknamed? = !@name.nil?
  def name = @name || speciesName
  def shiny? = !!@shiny
  def gender = 0
end

class Box
  attr_reader :name
  def initialize(name) = (@name = name; @slots = Array.new(30))
  def [](i) = @slots[i]
  def []=(i, v)
    @slots[i] = v
  end
  def length = 30
end

class Storage
  def initialize = (@boxes = [Box.new("Box 1"), Box.new("Box 2")])
  def maxBoxes = @boxes.length
  def maxPokemon(_box) = 30
  def [](x, y = nil) = y.nil? ? @boxes[x] : @boxes[x][y]
end

class Trainer
  attr_accessor :party, :name
  def initialize = (@party = []; @name = "Ash")
  def badge_count = 1
  def money = 3000
end

class PokemonGlobalMetadata; end
class GameTemp
  attr_accessor :in_battle
end
class GameMap
  def map_id = 2
end

module Graphics
  def self.update; end
end

# Simplified version of the game's pbFuse: the first Pokémon becomes the fusion.
def pbFuse(pokemon_body, pokemon_head, _item, _fusion_pif_sprite = nil)
  body = GameData::Species.get(pokemon_body.species).id_number
  head = GameData::Species.get(pokemon_head.species).id_number
  pokemon_body.species = GameData::Species.get(body * NB_POKEMON + head).id
  true
end

class ModTest < Minitest::Test
  MOD = File.expand_path("../game/Data/Scripts/998_SoulLinkTracker/001_SoulLinkTracker.rb", __dir__)

  def setup
    @dir = Dir.mktmpdir
    @old = Dir.pwd
    Dir.chdir(@dir)
    unless defined?(SoulLinkTracker)
      load MOD
    end
    $Trainer = Trainer.new
    $PokemonGlobal = PokemonGlobalMetadata.new
    $PokemonStorage = Storage.new
    $game_temp = GameTemp.new
    $game_map = GameMap.new
    $PokemonSystem = PokemonSystem.new
    GameData::Species.drawn = []
    SoulLinkTracker.instance_variable_set(:@sprite_files, {})
    SoulLinkTracker.instance_variable_set(:@sprite_failed, {})
    SoulLinkTracker.instance_variable_set(:@sprites_off, false)
    SoulLinkTracker.instance_variable_set(:@next_party, 0)
    SoulLinkTracker.instance_variable_set(:@next_full, 0)
    SoulLinkTracker.instance_variable_set(:@last_trainer, nil)
  end

  def teardown
    Dir.chdir(@old)
    FileUtils.rm_rf(@dir)
  end

  def tick
    SoulLinkTracker.instance_variable_set(:@next_party, 0)
    SoulLinkTracker.instance_variable_set(:@next_full, 0)
    Graphics.update
    refute File.exist?("SoulLink/error.log"), (File.read("SoulLink/error.log") rescue "")
    JSON.parse(File.read("SoulLink/state.json", encoding: "UTF-8"))
  end

  def test_writes_party_and_boxes_with_routes
    $Trainer.party << Pokemon.new(:BULBASAUR, 1)
    $Trainer.party << Pokemon.new(:RATTATA, 2).tap { |p| p.name = "Rätti \"1\"" }
    $PokemonStorage[0][3] = Pokemon.new(:PIDGEY, 2)
    state = tick
    assert_equal ["Pallet Town", "Route 1"], state["party"].map { |m| m["tags"][0]["route"] }
    assert_equal "Rätti \"1\"", state["party"][1]["name"]
    assert_equal 1, state["boxes"].length
    assert_equal "Box 1", state["boxes"][0]["box_name"]
    assert_equal [1, 2, 3], (state["party"] + state["boxes"]).map { |m| m["tags"][0]["seq"] }
    assert_equal "Route 1", state["map"]
    assert_equal "Ash", state["trainer"]["name"]
  end

  def test_tags_stay_stable_and_hp_updates_in_battle
    $Trainer.party << Pokemon.new(:PIKACHU, 3)
    id = tick["party"][0]["tags"][0]["id"]
    $game_temp.in_battle = true
    $Trainer.party[0].hp = 0
    state = tick
    assert_equal id, state["party"][0]["tags"][0]["id"]
    assert_equal 0, state["party"][0]["hp"]
    assert state["in_battle"]
  end

  def test_fusion_keeps_both_tags_and_unfusion_restores_them
    body = Pokemon.new(:BULBASAUR, 1)
    head = Pokemon.new(:RATTATA, 2)
    $Trainer.party.push(body, head)
    before = tick["party"].map { |m| m["tags"][0]["id"] }

    pbFuse(body, head, :DNASPLICERS, nil)   # 6.8+ passes the chosen sprite as 4th argument
    $Trainer.party.delete(head)
    state = tick
    assert_equal 1, state["party"].length
    fused = state["party"][0]
    assert fused["fusion"]
    assert_equal before, fused["tags"].map { |t| t["id"] }
    assert_equal "RATTATA", fused["head"]["species"]
    assert_equal "BULBASAUR", fused["body"]["species"]

    # unfuse: the game reverts the survivor and creates a brand-new head Pokémon
    body.species = :BULBASAUR
    $Trainer.party << Pokemon.new(:RATTATA, 3)
    state = tick
    ids = state["party"].map { |m| m["tags"].map { |t| t["id"] } }
    assert_equal [[before[0]], [before[1]]], ids
    assert_equal "Route 1", state["party"][1]["tags"][0]["route"]
  end

  def test_unchanged_state_is_not_rewritten
    $Trainer.party << Pokemon.new(:PIKACHU, 3)
    tick
    File.write("SoulLink/state.json", "marker")
    SoulLinkTracker.instance_variable_set(:@next_party, 0)
    Graphics.update
    assert_equal "marker", File.read("SoulLink/state.json")
  end

  def test_special_characters_are_valid_json
    $Trainer.party << Pokemon.new(:NIDORANfE, 1).tap { |p| p.name = "Ni\\do\n♀" }
    state = tick
    assert_equal "Ni\\do\n♀", state["party"][0]["name"]
    assert_equal "NIDORANfE", state["party"][0]["species"]
  end

  def test_exports_the_sprite_the_game_shows_once_per_variant
    $Trainer.party << Pokemon.new(:PIKACHU, 3)
    $Trainer.party << Pokemon.new(:PIKACHU, 2)
    state = tick
    key = state["party"][0]["sprite"]
    assert_equal "BASE-25", key
    assert_equal key, state["party"][1]["sprite"]
    assert_equal "\x89PNG25".b, File.binread("SoulLink/sprites/#{key}.png")
    assert_equal [:PIKACHU], GameData::Species.drawn   # same variant drawn only once

    # player picks another alt sprite for Pikachu in the game
    $PokemonSystem.alt_sprite_substitutions[25] = PIFSprite.new(:BASE, 25, nil, "b", nil)
    $Trainer.party[0].shiny = true
    state = tick
    assert_equal "BASE-25-b-S00", state["party"][0]["sprite"]
    assert_equal "BASE-25-b", state["party"][1]["sprite"]
    assert_equal "\x89PNG25bshiny".b, File.binread("SoulLink/sprites/BASE-25-b-S00.png")
  end

  def test_random_sprites_use_the_pokemons_own_sprite
    $PokemonSystem.random_sprites = true
    mon = Pokemon.new(:RATTATA, 2)
    mon.pif_sprite = PIFSprite.new(:CUSTOM, 19, 25, "c", nil)
    $Trainer.party << mon
    assert_equal "CUSTOM-19-25-c", SoulLinkTracker.sprite_key(mon)
  end

  def test_box_pokemon_without_chosen_sprite_are_not_drawn
    $PokemonStorage[0][0] = Pokemon.new(:PIDGEY, 2)
    state = tick
    assert_empty GameData::Species.drawn
    assert_nil state["boxes"][0]["sprite"]
  end

  def test_no_save_loaded_does_nothing
    $Trainer = nil
    Graphics.update
    refute File.exist?("SoulLink/state.json")
  end
end
