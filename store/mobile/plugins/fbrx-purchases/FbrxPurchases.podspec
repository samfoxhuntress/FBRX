require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'FbrxPurchases'
  s.version = package['version']
  s.summary = package['description']
  s.license = 'UNLICENSED'
  s.homepage = 'https://github.com/samfoxhuntress/FBRX'
  s.author = 'FBRX'
  s.source = { :git => 'https://github.com/samfoxhuntress/FBRX.git', :tag => s.version.to_s }
  s.source_files = 'ios/Sources/**/*.{swift,h,m}'
  s.ios.deployment_target = '15.0'
  s.dependency 'Capacitor'
  s.swift_version = '5.9'
  s.frameworks = 'StoreKit'
end
