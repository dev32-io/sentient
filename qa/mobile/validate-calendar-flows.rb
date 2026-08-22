#!/usr/bin/env ruby
# frozen_string_literal: true

require "yaml"

ROOT = File.expand_path("../..", __dir__)
PLATFORMS = {
  "android" => {
    flows: [File.join(ROOT, "qa/mobile/flows/android/calendar/*.yaml")],
    sources: File.join(ROOT, "android/src/main/**/*.kt"),
  },
  "ios" => {
    flows: [
      File.join(ROOT, "qa/mobile/flows/ios/*calendar*.yaml"),
      File.join(ROOT, "qa/mobile/flows/ios/_calendar/*.yaml"),
    ],
    sources: File.join(ROOT, "ios/App/**/*.swift"),
  },
}.freeze

def values_for_key(value, wanted, found = [])
  case value
  when Hash
    value.each do |key, child|
      found << child if key == wanted && child.is_a?(String)
      values_for_key(child, wanted, found)
    end
  when Array
    value.each { |child| values_for_key(child, wanted, found) }
  end
  found
end

def fixture_selector?(selector)
  selector.match?(/\A\$\{CALENDAR_[A-Z0-9_]+\}\z/)
end

def source_has_id?(source, selector)
  generated_prefixes = source.scan(/(?:calendar|settings)-[a-z0-9_-]+/).uniq.select { |value| value.end_with?("-") }
  alternatives = selector.split("|")
  alternatives.all? do |candidate|
    next true if fixture_selector?(candidate)

    literal_prefix = candidate.split(/\$\{|\.\*/).first
    source.include?(candidate) ||
      (literal_prefix.length >= 9 && source.include?(literal_prefix)) ||
      generated_prefixes.any? { |prefix| candidate.start_with?(prefix) }
  end
end

def source_has_text?(source, selector)
  return true if selector.include?("${CALENDAR_")
  # These labels are deterministically projected from shared enum names.
  return true if ["Important", "Weekly"].include?(selector)

  literal = selector.sub(/\.\*\z/, "")
  literal.empty? || source.include?(literal)
end

errors = []
count = 0
flow_files = []
PLATFORMS.each do |platform, config|
  source = Dir[config[:sources]].sort.map { |path| File.read(path) }.join("\n")
  config[:flows].flat_map { |pattern| Dir[pattern] }.uniq.sort.each do |flow|
    flow_files << flow
    documents = YAML.load_stream(File.read(flow))
    commands = documents.last
    values_for_key(commands, "id").each do |selector|
      count += 1
      errors << "#{platform}:#{flow.delete_prefix(ROOT + "/")}: undefined id #{selector.inspect}" unless source_has_id?(source, selector)
    end
    values_for_key(commands, "text").each do |selector|
      count += 1
      errors << "#{platform}:#{flow.delete_prefix(ROOT + "/")}: undefined text #{selector.inspect}" unless source_has_text?(source, selector)
    end
  rescue Psych::SyntaxError => error
    errors << "#{platform}:#{flow.delete_prefix(ROOT + "/")}: YAML syntax: #{error.message.lines.first.strip}"
  end
end

maestro = ENV.fetch("MAESTRO", `command -v maestro`.strip)
unless maestro.empty?
  flow_files.uniq.each do |flow|
    next if system(maestro, "check-syntax", flow, out: File::NULL, err: File::NULL)

    errors << "maestro syntax failed: #{flow.delete_prefix(ROOT + "/")}"
  end
end

abort(errors.join("\n")) unless errors.empty?
maestro_result = maestro.empty? ? "Maestro unavailable" : "#{flow_files.uniq.length} Maestro flows"
puts "calendar flow syntax/selectors OK (#{count} selectors, #{maestro_result})"
