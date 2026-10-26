Pod::Spec.new do |s|
  s.name           = 'LeveragePasswordKdf'
  s.version        = '1.0.0'
  s.summary        = 'Native PBKDF2-SHA256 for Leverage local profile authentication.'
  s.description    = 'Derives the existing PBKDF2-SHA256 profile hash format using the Apple CommonCrypto implementation.'
  s.license        = { :type => 'MIT' }
  s.author         = 'Leverage'
  s.homepage       = 'https://expo.dev'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { :git => 'https://github.com/MuhammadAliyan10/HouseLog.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.{h,m,mm,swift}'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
